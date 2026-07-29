const { runAgentTurn, AGENT_PROMPTS } = require('./agents');

// Shared bar for what actually counts as "disruptive" - reused in every QA/Supervisor
// safety-audit prompt below. Narrowed deliberately: the user has standing authorization
// for PATTI to do anything they've asked for using the recommended approach, so this
// gate should only fire for genuinely harmful, irreversible actions to the system or
// its data - not for routine requested work like installing a dependency or restarting
// an app-level service.
const DISRUPTION_CRITERIA = `### What Actually Counts as "Disruptive" (CRITICAL - narrow bar)
Only flag "can_cause_disruptions" as true for actions that could cause genuine, irreversible harm:
- Irreversibly deleting or overwriting data/files OUTSIDE the project workspace, or deleting/overwriting far more inside it than what was actually asked for
- Actions that could corrupt or brick the system, the OS, or a connected device
- Disabling or weakening security controls (firewall, antivirus, authentication, encryption, access controls)
- Exposing, logging, or transmitting secrets, credentials, or API keys
- Any other action whose realistic failure mode is irreversible data loss or system damage the user did not clearly ask for
Do NOT flag routine, requested, reversible actions - these should be approved without hesitation: installing or uninstalling a package the user asked for, writing or editing project files, running the project's own dev/test/build/lint commands, restarting an application-level service (not an OS or security service), git operations, or other standard automation the user requested. Assume the user wants PATTI to proceed with the recommended approach for anything they've asked for - only pause for genuine, irreversible harm to the system or its information.`;

async function verifyCommandWithQAAndSupervisor(command, agentName, settings) {
  // 1. QA Engineer review
  const qaSystemPrompt = AGENT_PROMPTS.qa_engineer + `\n\n### Code/Command Execution Safety Audit
You are reviewing a request by agent "${agentName}" to execute the following command:
"${command}"

Please analyze this command for security vulnerabilities and genuine potential for system disruption.
${DISRUPTION_CRITERIA}
You MUST output your decision using the standard JSON format, placing your evaluation in the "params" object:
{
  "thought": "your step-by-step reasoning",
  "tool": "none",
  "action": "audit",
  "params": {
    "approved": true,
    "can_cause_disruptions": false,
    "reason": "explanation of your safety audit"
  }
}`;

  let qaResult = { approved: true, can_cause_disruptions: false, reason: "No QA analysis available" };
  try {
    const qaTurn = await runAgentTurn('qa_engineer', qaSystemPrompt, settings, `Audit command: ${command}`, []);
    if (qaTurn && qaTurn.params) {
      qaResult = {
        approved: qaTurn.params.approved !== false,
        can_cause_disruptions: qaTurn.params.can_cause_disruptions === true,
        reason: qaTurn.params.reason || qaTurn.thought || "No reason provided"
      };
    }
  } catch (err) {
    console.error('QA verification failed, defaulting to cautious mode:', err);
    qaResult = { approved: false, can_cause_disruptions: true, reason: `QA review failed: ${err.message}` };
  }

  // If QA rejects, do NOT ask the supervisor (Sequential rule)
  if (!qaResult.approved) {
    return {
      qaResult,
      supervisorResult: {
        approved_without_user: false,
        can_cause_disruptions: true,
        reason: "Bypassed - QA did not approve this command execution."
      }
    };
  }

  // 2. Supervisor review (notified of QA approval)
  const supervisorSystemPrompt = AGENT_PROMPTS.supervisor + `\n\n### Supervisor Code Execution Review
Agent "${agentName}" wants to run the command: "${command}".

NOTE: The QA Engineer has already AUDITED and APPROVED this command execution request with the following report:
${JSON.stringify(qaResult)}

Evaluate the command and the QA report.
${DISRUPTION_CRITERIA}
Determine:
1. Is the command ok to run?
2. Can it cause genuine, irreversible disruptions per the criteria above?
If it is safe (including routine, requested, reversible actions), set "approved_without_user" to true.
Only if it meets the disruption criteria above, set "can_cause_disruptions" to true and "approved_without_user" to false.

You MUST output your decision using the standard JSON format, placing your evaluation in the "params" object:
{
  "thought": "your step-by-step reasoning",
  "tool": "none",
  "action": "evaluate",
  "params": {
    "approved_without_user": true,
    "can_cause_disruptions": false,
    "reason": "explanation of your evaluation"
  }
}`;

  let supervisorResult = { approved_without_user: true, can_cause_disruptions: false, reason: "No Supervisor analysis available" };
  try {
    const supervisorTurn = await runAgentTurn('supervisor', supervisorSystemPrompt, settings, `Verify command and QA report: ${command}`, []);
    if (supervisorTurn && supervisorTurn.params) {
      supervisorResult = {
        approved_without_user: supervisorTurn.params.approved_without_user === true,
        can_cause_disruptions: supervisorTurn.params.can_cause_disruptions === true || supervisorTurn.params.approved_without_user === false,
        reason: supervisorTurn.params.reason || supervisorTurn.thought || "No reason provided"
      };
    }
  } catch (err) {
    console.error('Supervisor verification failed, defaulting to cautious mode:', err);
    supervisorResult = { approved_without_user: false, can_cause_disruptions: true, reason: `Supervisor review failed: ${err.message}` };
  }

  return { qaResult, supervisorResult };
}

async function verifyWriteFileWithQAAndSupervisor(filePath, content, agentName, settings) {
  // 1. QA Engineer review
  const qaSystemPrompt = AGENT_PROMPTS.qa_engineer + `\n\n### Code/File Write Safety Audit
You are reviewing a request by agent "${agentName}" to write the following file:
File Path: "${filePath}"
Content:
${content}

Please analyze this file write for security vulnerabilities and genuine potential for system disruption.
${DISRUPTION_CRITERIA}
You MUST output your decision using the standard JSON format, placing your evaluation in the "params" object:
{
  "thought": "your step-by-step reasoning",
  "tool": "none",
  "action": "audit",
  "params": {
    "approved": true,
    "can_cause_disruptions": false,
    "reason": "explanation of your safety audit"
  }
}`;

  let qaResult = { approved: true, can_cause_disruptions: false, reason: "No QA analysis available" };
  try {
    const qaTurn = await runAgentTurn('qa_engineer', qaSystemPrompt, settings, `Audit file write at: ${filePath}`, []);
    if (qaTurn && qaTurn.params) {
      qaResult = {
        approved: qaTurn.params.approved !== false,
        can_cause_disruptions: qaTurn.params.can_cause_disruptions === true,
        reason: qaTurn.params.reason || qaTurn.thought || "No reason provided"
      };
    }
  } catch (err) {
    console.error('QA file verification failed, defaulting to cautious mode:', err);
    qaResult = { approved: false, can_cause_disruptions: true, reason: `QA review failed: ${err.message}` };
  }

  // If QA rejects, do NOT ask the supervisor (Sequential rule)
  if (!qaResult.approved) {
    return {
      qaResult,
      supervisorResult: {
        approved_without_user: false,
        can_cause_disruptions: true,
        reason: "Bypassed - QA did not approve this file write."
      }
    };
  }

  // 2. Supervisor review (notified of QA approval)
  const supervisorSystemPrompt = AGENT_PROMPTS.supervisor + `\n\n### Supervisor Code/File Write Review
Agent "${agentName}" wants to write the file: "${filePath}" with the content:
${content}

NOTE: The QA Engineer has already AUDITED and APPROVED this file write request with the following report:
${JSON.stringify(qaResult)}

Evaluate the file write and the QA report.
${DISRUPTION_CRITERIA}
Determine:
1. Is the file write ok to proceed?
2. Can it cause genuine, irreversible disruptions per the criteria above?
If it is safe (including routine, requested, reversible writes like project files the user asked for), set "approved_without_user" to true.
Only if it meets the disruption criteria above, set "can_cause_disruptions" to true and "approved_without_user" to false.

You MUST output your decision using the standard JSON format, placing your evaluation in the "params" object:
{
  "thought": "your step-by-step reasoning",
  "tool": "none",
  "action": "evaluate",
  "params": {
    "approved_without_user": true,
    "can_cause_disruptions": false,
    "reason": "explanation of your evaluation"
  }
}`;

  let supervisorResult = { approved_without_user: true, can_cause_disruptions: false, reason: "No Supervisor analysis available" };
  try {
    const supervisorTurn = await runAgentTurn('supervisor', supervisorSystemPrompt, settings, `Verify file write and QA report for: ${filePath}`, []);
    if (supervisorTurn && supervisorTurn.params) {
      supervisorResult = {
        approved_without_user: supervisorTurn.params.approved_without_user === true,
        can_cause_disruptions: supervisorTurn.params.can_cause_disruptions === true || supervisorTurn.params.approved_without_user === false,
        reason: supervisorTurn.params.reason || supervisorTurn.thought || "No reason provided"
      };
    }
  } catch (err) {
    console.error('Supervisor file verification failed, defaulting to cautious mode:', err);
    supervisorResult = { approved_without_user: false, can_cause_disruptions: true, reason: `Supervisor review failed: ${err.message}` };
  }

  return { qaResult, supervisorResult };
}

module.exports = { verifyCommandWithQAAndSupervisor, verifyWriteFileWithQAAndSupervisor };
