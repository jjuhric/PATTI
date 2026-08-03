// Mock @google/generative-ai before imports
jest.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => {
      return {
        getGenerativeModel: jest.fn()
      };
    })
  };
});

let shouldDiskFail = false;
let shouldPowerFail = false;
let shouldTempFail = false;
let shouldWindowsCommandsFail = false;

// Link flags to global to be safely accessible in hoisted jest.mock
Object.defineProperty(global, 'shouldPowerFail', {
  get: () => shouldPowerFail,
  set: (val) => { shouldPowerFail = val; },
  configurable: true
});

Object.defineProperty(global, 'shouldTempFail', {
  get: () => shouldTempFail,
  set: (val) => { shouldTempFail = val; },
  configurable: true
});

Object.defineProperty(global, 'shouldWindowsCommandsFail', {
  get: () => shouldWindowsCommandsFail,
  set: (val) => { shouldWindowsCommandsFail = val; },
  configurable: true
});

jest.mock('../tools/ina219_tool', () => {
  return {
    measurePower: jest.fn().mockImplementation(async () => {
      if (global.shouldPowerFail) {
        throw new Error('Power script execution failed');
      }
      return {
        success: true,
        simulated: true,
        readings: [
          { battery_percent: 85.5, power_w: 2.45, voltage_v: 12.08, current_a: 0.203 },
          { battery_percent: 85.5, power_w: 2.45, voltage_v: 12.08, current_a: 0.203 },
          { battery_percent: 85.5, power_w: 2.45, voltage_v: 12.08, current_a: 0.203 }
        ],
        average: {
          battery_percent: 85.5,
          power_w: 2.45,
          voltage_v: 12.08,
          current_a: 0.203
        }
      };
    })
  };
});

jest.mock('../tools/temp_tool', () => {
  return {
    measureCpuTemp: jest.fn().mockImplementation(async () => {
      if (global.shouldTempFail) {
        throw new Error('Temp sensor execution failed');
      }
      return {
        success: true,
        simulated: true,
        readings: [
          { celsius: 42.5, fahrenheit: 108.5 },
          { celsius: 42.5, fahrenheit: 108.5 },
          { celsius: 42.5, fahrenheit: 108.5 }
        ],
        average: {
          celsius: 42.5,
          fahrenheit: 108.5
        }
      };
    })
  };
});

// Mock child_process.exec before requiring modules
const customPromisify = (cmd, opts) => {
  return new Promise((resolve, reject) => {
    if (global.shouldWindowsCommandsFail) {
      reject(new Error('Simulated Windows Command Failure'));
      return;
    }
    if (shouldDiskFail && (cmd.includes('Get-PSDrive') || cmd.includes('df -h'))) {
      reject(new Error('Disk check failed'));
      return;
    }
    if (shouldPowerFail && cmd.includes('ina219_read.py')) {
      reject(new Error('Power script execution failed'));
      return;
    }
    if (cmd.includes('invalid_cmd')) {
      const err = new Error('Command execution failed');
      err.code = 127;
      err.stdout = 'some stdout';
      err.stderr = 'some stderr';
      reject(err);
    } else if (cmd.includes('Get-PSDrive')) {
      resolve({
        stdout: JSON.stringify([{ Name: 'C', Used: 50 * 1024 ** 3, Free: 150 * 1024 ** 3 }]),
        stderr: ''
      });
    } else if (cmd.includes('df -h')) {
      resolve({ stdout: 'df -h output', stderr: '' });
    } else if (cmd.includes('ina219_read.py')) {
      resolve({
        stdout: JSON.stringify({
          success: true,
          battery_percent: 85.5,
          power_w: 2.45,
          voltage_v: 12.08,
          current_a: 0.203
        }),
        stderr: ''
      });
    } else {
      resolve({ stdout: 'Command output', stderr: '' });
    }
  });
};

jest.mock('child_process', () => {
  const execMock = jest.fn((cmd, opts, callback) => {
    const cb = typeof opts === 'function' ? opts : callback;
    cb(null, 'Command output', '');
  });
  execMock[Symbol.for('nodejs.util.promisify.custom')] = customPromisify;
  return { exec: execMock };
});

const { handleHostMachineTool } = require('../tools/host_machine_tool');
const { handleCoderTool } = require('../tools/coder_tools');
const { handleWeatherTool } = require('../tools/weather_tool');
const { runAgentTurn, runWorkerAgent, runSupervisorHandoff, AGENT_PROMPTS } = require('../utils/agents');
const { runAgentLoop } = require('../ai');
const fs = require('fs');
const path = require('path');

describe('Agent Prompt Files', () => {
  // AGENT_PROMPTS lazily require()s each utils/agents/<name>.js file (they're
  // just JS template-literal strings) and silently swallows any load error
  // into `undefined` with only a console warning - so a typo like an
  // unescaped backtick inside the template literal breaks that agent at
  // runtime ("Unknown agent: X") without ever failing a build or test unless
  // something explicitly checks every file loads. This does that.
  const agentsDir = path.join(__dirname, '../utils/agents');
  const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.js'));

  test('directory is not empty (sanity check that the glob above actually ran)', () => {
    expect(agentFiles.length).toBeGreaterThan(5);
  });

  test.each(agentFiles.map(f => f.replace(/\.js$/, '')))('%s loads as a non-empty prompt string', (agentName) => {
    expect(() => require(path.join(agentsDir, `${agentName}.js`))).not.toThrow();
    const prompt = AGENT_PROMPTS[agentName];
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(20);
  });
});

describe('Multi-Agent System & Tools Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Host Machine Tool', () => {
    test('retrieves host details successfully on win32', async () => {
      const os = require('os');
      const platformSpy = jest.spyOn(os, 'platform').mockReturnValue('win32');
      const result = await handleHostMachineTool('get_specifications');
      expect(result).toHaveProperty('OS');
      expect(result).toHaveProperty('Release');
      expect(result).toHaveProperty('Processor');
      expect(result.RAM_GB).toBeDefined();
      platformSpy.mockRestore();
    });

    test('host_machine_tool on non-win32 platform', async () => {
      const os = require('os');
      const platformSpy = jest.spyOn(os, 'platform').mockReturnValue('linux');
      const result = await handleHostMachineTool('get_specifications');
      expect(result).toHaveProperty('OS');
      expect(result).toHaveProperty('Release');
      expect(result).toHaveProperty('Processor');
      expect(result.RAM_GB).toBeDefined();
      platformSpy.mockRestore();
    });

    test('host_machine_tool handles total system error', async () => {
      const os = require('os');
      const memSpy = jest.spyOn(os, 'totalmem').mockImplementation(() => {
        throw new Error('Total memory error');
      });
      const result = await handleHostMachineTool('get_specifications');
      expect(result).toContain('Error retrieving host machine specifications: Total memory error');
      memSpy.mockRestore();
    });

    test('host_machine_tool get_power retrieves battery details', async () => {
      const result = await handleHostMachineTool('get_power');
      expect(result).toContain('Power & Battery Status');
      expect(result).toContain('85.5%');
      expect(result).toContain('2.45 W');
    });

    test('host_machine_tool get_power handles python execution failures gracefully', async () => {
      shouldPowerFail = true;
      const result = await handleHostMachineTool('get_power');
      expect(result).toContain('Failed to read power telemetry');
      shouldPowerFail = false;
    });

    test('host_machine_tool get_temperature retrieves CPU temperature details', async () => {
      const result = await handleHostMachineTool('get_temperature');
      expect(result).toContain('CPU Temperature');
      expect(result).toContain('42.5°C');
      expect(result).toContain('108.5°F');
    });

    test('host_machine_tool get_temperature handles failures gracefully', async () => {
      shouldTempFail = true;
      const result = await handleHostMachineTool('get_temperature');
      expect(result).toContain('Failed to read CPU temperature');
      shouldTempFail = false;
    });

    test('host_machine_tool new actions - get_network_info, get_process_list, check_updates on win32', async () => {
      const os = require('os');
      const platformSpy = jest.spyOn(os, 'platform').mockReturnValue('win32');
      
      const netRes = await handleHostMachineTool('get_network_info');
      expect(netRes).toContain('Windows Network Information');

      const procRes = await handleHostMachineTool('get_process_list');
      expect(procRes).toContain('Host Process List');

      const updRes = await handleHostMachineTool('check_updates');
      expect(updRes).toContain('System package update check is only supported on Debian/Ubuntu Linux.');

      platformSpy.mockRestore();
    });

    test('host_machine_tool new actions - get_network_info, get_process_list, check_updates on linux', async () => {
      const os = require('os');
      const platformSpy = jest.spyOn(os, 'platform').mockReturnValue('linux');
      
      const netRes = await handleHostMachineTool('get_network_info');
      expect(netRes).toContain('Linux Network Information');

      const procRes = await handleHostMachineTool('get_process_list');
      expect(procRes).toContain('Host Process List');

      const updRes = await handleHostMachineTool('check_updates');
      expect(updRes).toContain('Dry Run System Package Updates');

      platformSpy.mockRestore();
    });

    test('host_machine_tool new actions - get_service_status, get_journal_logs, restart_service on linux', async () => {
      const os = require('os');
      const platformSpy = jest.spyOn(os, 'platform').mockReturnValue('linux');
      process.env.DEVICE_TYPE_OVERRIDE = 'rpi-5-8gb'; // Just to bypass if it reads from db/env

      const statusRes = await handleHostMachineTool('get_service_status', { service: 'patti' });
      expect(statusRes).toContain('Service Status: patti');

      const logsRes = await handleHostMachineTool('get_journal_logs', { service: 'patti', lines: 10 });
      expect(logsRes).toContain('Journal Logs for patti');

      const restartRes = await handleHostMachineTool('restart_service', { service: 'patti' });
      expect(restartRes).toContain('Successfully restarted service "patti".');

      platformSpy.mockRestore();
      delete process.env.DEVICE_TYPE_OVERRIDE;
    });

    test('host_machine_tool new actions - get_service_status, get_journal_logs, restart_service on win32', async () => {
      const os = require('os');
      const platformSpy = jest.spyOn(os, 'platform').mockReturnValue('win32');

      const statusRes = await handleHostMachineTool('get_service_status', { service: 'patti' });
      expect(statusRes).toContain('Windows Server Task & Process Status');
      expect(statusRes).toContain('Active Node Processes');

      const logsRes = await handleHostMachineTool('get_journal_logs', { service: 'patti' });
      expect(logsRes).toContain('Windows Event Logs (Application - Last 100 entries)');

      const restartRes = await handleHostMachineTool('restart_service', { service: 'patti' });
      expect(restartRes).toContain('Successfully restarted Windows scheduled task "PATTI-Assistant"');

      // Test command failures on win32
      global.shouldWindowsCommandsFail = true;

      const statusFail = await handleHostMachineTool('get_service_status', { service: 'patti' });
      expect(statusFail).toContain('Scheduled Task check failed');

      const logsFail = await handleHostMachineTool('get_journal_logs', { service: 'patti' });
      expect(logsFail).toContain('Error retrieving Windows Event Logs');

      const restartFail = await handleHostMachineTool('restart_service', { service: 'patti' });
      expect(restartFail).toContain('Error restarting Windows service/task');

      global.shouldWindowsCommandsFail = false;
      platformSpy.mockRestore();
    });

    test('host_machine_tool run_script executes safe script files', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);

      const pythonRes = await handleHostMachineTool('run_script', { scriptPath: 'script.py' });
      expect(pythonRes).toContain('Command output');

      const bashRes = await handleHostMachineTool('run_script', { scriptPath: 'script.sh' });
      expect(bashRes).toContain('Command output');

      existsSpy.mockRestore();
    });

    test('host_machine_tool run_script returns error on missing or invalid script', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);

      const missingRes = await handleHostMachineTool('run_script', { scriptPath: 'missing.py' });
      expect(missingRes).toContain('Error: Script not found');

      existsSpy.mockRestore();
    });

    test('host_machine_tool new actions missing parameters', async () => {
      const statusRes = await handleHostMachineTool('get_service_status', {});
      expect(statusRes).toContain('Error: "service" parameter is required.');

      const logsRes = await handleHostMachineTool('get_journal_logs', {});
      expect(logsRes).toContain('Error: "service" parameter is required.');

      const restartRes = await handleHostMachineTool('restart_service', {});
      expect(restartRes).toContain('Error: "service" parameter is required.');

      const scriptRes = await handleHostMachineTool('run_script', {});
      expect(scriptRes).toContain('Error: "scriptPath" parameter is required.');
    });

    test('host_machine_tool security_scan on win32 and linux', async () => {
      const os = require('os');
      
      // Test win32
      const platformSpyWin = jest.spyOn(os, 'platform').mockReturnValue('win32');
      const scanWin = await handleHostMachineTool('security_scan');
      expect(scanWin).toContain('Security Scan Report');
      expect(scanWin).toContain('Windows');
      platformSpyWin.mockRestore();

      // Test linux
      const platformSpyLin = jest.spyOn(os, 'platform').mockReturnValue('linux');
      const scanLin = await handleHostMachineTool('security_scan');
      expect(scanLin).toContain('Security Scan Report');
      expect(scanLin).toContain('Linux');
      platformSpyLin.mockRestore();
    });
  });

  describe('Coder Tools', () => {
    test('read_file returns file contents or error', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true });
      const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('console.log("hello");');

      const result = await handleCoderTool('read_file', { filePath: 'test.js' });
      expect(result).toContain('console.log("hello");');

      // Test validation error
      const errRes = await handleCoderTool('read_file', {});
      expect(errRes).toContain('Error: "filePath" parameter is required.');

      existsSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
    });

    test('write_file writes content successfully', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = await handleCoderTool('write_file', { filePath: 'test.js', content: 'test content' });
      expect(result).toContain('Successfully wrote content');

      const errRes = await handleCoderTool('write_file', {});
      expect(errRes).toContain('Error: "filePath" parameter is required.');

      existsSpy.mockRestore();
      writeSpy.mockRestore();
    });

    test('list_dir lists directory details', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true, isFile: () => false });
      const readdirSpy = jest.spyOn(fs, 'readdirSync').mockReturnValue(['file1.txt']);

      const result = await handleCoderTool('list_dir', { dirPath: '.' });
      expect(result).toContain('file1.txt');

      existsSpy.mockRestore();
      statSpy.mockRestore();
      readdirSpy.mockRestore();
    });

    test('execute_command runs command', async () => {
      const result = await handleCoderTool('execute_command', { command: 'node -v' });
      expect(result).toContain('Command output');

      const errRes = await handleCoderTool('execute_command', {});
      expect(errRes).toContain('Error: "command" parameter is required.');
    });

    test('safe path traversal check throws error', async () => {
      const result = await handleCoderTool('read_file', { filePath: '../outside/workspace.js' });
      expect(result).toContain('Access denied');
    });
  });

  describe('Weather Tool One Call', () => {
    test('onecall action returns One Call report', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ lat: 30.5, lon: -85.1, name: 'Altha' })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            current: { temp: 75, feels_like: 76, humidity: 80, wind_speed: 5, weather: [{ description: 'sunny' }] },
            daily: [{ dt: 1719830400, temp: { day: 80, night: 65 }, weather: [{ description: 'partly cloudy' }] }]
          })
        });

      const mockDb = {
        get: jest.fn().mockResolvedValue({
          zipcode: '32421',
          country: 'US',
          temp_unit: 'imperial',
          weather_api_key: 'testkey'
        })
      };

      const result = await handleWeatherTool(mockDb, 1, 'onecall', { zipcode: '32421' });
      expect(result).toContain('OpenWeatherMap One Call API Report');
      expect(result).toContain('Altha');
      expect(result).toContain('75°F');

      global.fetch = globalFetch;
    });
  });

  describe('Agents Utility & Orchestration', () => {
    test('runWorkerAgent invokes specified worker loop and returns response report', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ thought: 'Deciding to finish', tool: 'none' }) } }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: 'Worker agent response summary.' } }]
          })
        });

      const result = await runWorkerAgent('system_specialist', { provider: 'openai', modelName: 'gpt-4' }, 'Check specs', null, 1);
      expect(result).toBe('{"status":"success","summary":"Worker agent response summary.","data":{}}');

      global.fetch = globalFetch;
    });
  });

  describe('Supervisor Agent Integration (ai.js)', () => {
    test('runAgentLoop delegates to worker agent and creates final output', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ thought: 'Delegating weather task', tool: 'delegate_to_weather_expert', params: { task: 'get weather for Altha' } }) } }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ thought: 'Done now', tool: 'none' }) } }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: 'Weather is sunny and 75 degrees.' } }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ thought: 'Summary complete', tool: 'none' }) } }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: 'Here is the summary: Weather is sunny and 75 degrees.' } }]
          })
        });

      const mockThought = jest.fn();
      const mockContent = jest.fn();
      const mockToolCall = jest.fn();

      await runAgentLoop({
        provider: 'openai',
        modelName: 'gpt-4',
        userMessage: 'What is the weather today?',
        history: [],
        onThought: mockThought,
        onContent: mockContent,
        onToolCall: mockToolCall
      });

      expect(mockThought).toHaveBeenCalled();
      expect(mockContent).toHaveBeenCalledWith('Here is the summary: Weather is sunny and 75 degrees.');
      expect(mockToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: 'delegate_to_weather_expert' }));

      global.fetch = globalFetch;
    });

    test('runAgentLoop supervisor with gemini provider', async () => {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const mockModel = {
        generateContent: jest.fn().mockResolvedValue({
          response: { text: () => JSON.stringify({ thought: 'gemini loop done', tool: 'none' }) }
        }),
        generateContentStream: jest.fn().mockResolvedValue({
          stream: (async function* () {
            yield { text: () => 'Stream content' };
          })()
        })
      };
      GoogleGenerativeAI.mockImplementation(() => ({
        getGenerativeModel: () => mockModel
      }));

      const mockThought = jest.fn();
      const mockContent = jest.fn();
      const mockToolCall = jest.fn();

      await runAgentLoop({
        provider: 'gemini',
        geminiKey: 'key',
        modelName: 'gemini-2.5-flash',
        userMessage: 'What is the weather today?',
        history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
        onThought: mockThought,
        onContent: mockContent,
        onToolCall: mockToolCall
      });

      expect(mockContent).toHaveBeenCalledWith('Stream content');
    });
  });

  describe('Agent Coverage Extensions', () => {
    test('read_file validation when path is a directory', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => false });
      const result = await handleCoderTool('read_file', { filePath: 'some_dir' });
      expect(result).toContain('is a directory, not a file');
      existsSpy.mockRestore();
      statSpy.mockRestore();
    });

    test('list_dir validation when path is not a directory', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false });
      const result = await handleCoderTool('list_dir', { dirPath: 'file.txt' });
      expect(result).toContain('is a file, not a directory');
      existsSpy.mockRestore();
      statSpy.mockRestore();
    });

    test('execute_command execution failure', async () => {
      const result = await handleCoderTool('execute_command', { command: 'invalid_cmd' });
      expect(result).toContain('Command execution failed');
    });

    test('unknown coding tool action', async () => {
      const result = await handleCoderTool('invalid_action', {});
      expect(result).toContain('Error: Unknown coding/QA tool action');
    });

    test('runWorkerAgent routes other tools (calendar, search_web, google_news)', async () => {
      const globalFetch = global.fetch;
      let calls = 0;
      global.fetch = jest.fn().mockImplementation((url) => {
        const urlStr = url || '';
        // Only count/mock LLM completion endpoint calls
        if (urlStr.includes('chat/completions') || urlStr.includes('completions')) {
          calls++;
          if (calls === 1) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Calling calendar', tool: 'calendar', action: 'list', params: { date: '2026-07-02' } }) } }] })
            });
          } else if (calls === 2) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Searching web', tool: 'search_web', params: { query: 'test' } }) } }] })
            });
          } else if (calls === 3) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Checking news', tool: 'google_news', params: { query: 'test' } }) } }] })
            });
          } else if (calls === 4) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Finishing', tool: 'none' }) } }] })
            });
          } else {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: 'Combined report' } }] })
            });
          }
        }

        // Return empty/ok mock for other requests (like web search / geocoding)
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ choices: [], results: [] })
        });
      });

      const mockDb = {
        all: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null)
      };

      const result = await runWorkerAgent('calendar_handler', { provider: 'openai', modelName: 'gpt-4' }, 'Manage calendar', mockDb, 1);
      expect(result).toContain('Combined report');
      global.fetch = globalFetch;
    });

    test('runAgentTurn with anthropic style', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ content: [{ text: JSON.stringify({ thought: 'anthropic done', tool: 'none' }) }] })
      });
      const result = await runAgentTurn('supervisor', 'system prompt', { provider: 'online', onlineProvider: 'anthropic', onlineUrl: 'http://anthropic' }, 'hello', []);
      expect(result.thought).toBe('anthropic done');
      global.fetch = globalFetch;
    });

    test('runAgentTurn with lm-studio style', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'lm done', tool: 'none' }) } }] })
      });
      const result = await runAgentTurn('supervisor', 'system prompt', { provider: 'local', localApiStyle: 'lm-studio', localBaseUrl: 'http://lm-studio' }, 'hello', []);
      expect(result.thought).toBe('lm done');
      global.fetch = globalFetch;
    });

    test('runAgentTurn retries a transient fetch failure with backoff and succeeds', async () => {
      const globalFetch = global.fetch;
      let callCount = 0;
      global.fetch = jest.fn(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('fetch failed');
        }
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'recovered', tool: 'none' }) } }] })
        };
      });

      const result = await runAgentTurn('news_agent', 'system prompt', { provider: 'local', localApiStyle: 'lm-studio', localBaseUrl: 'http://lm-studio' }, 'hello', []);
      expect(result.thought).toBe('recovered');
      expect(callCount).toBe(2);
      global.fetch = globalFetch;
    }, 15000);

    test('runAgentTurn throws after exhausting retries on repeated fetch failure', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn(async () => {
        throw new Error('fetch failed');
      });

      await expect(runAgentTurn('news_agent', 'system prompt', { provider: 'local', localApiStyle: 'lm-studio', localBaseUrl: 'http://lm-studio' }, 'hello', [])).rejects.toThrow('fetch failed');
      expect(global.fetch).toHaveBeenCalledTimes(3);
      global.fetch = globalFetch;
    }, 15000);

    test('runAgentTurn with gemini provider', async () => {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const mockEmbed = {
        generateContent: jest.fn().mockResolvedValue({
          response: { text: () => JSON.stringify({ thought: 'gemini done', tool: 'none' }) }
        })
      };
      GoogleGenerativeAI.mockImplementation(() => ({
        getGenerativeModel: () => mockEmbed
      }));

      const result = await runAgentTurn('supervisor', 'system prompt', { provider: 'gemini', geminiKey: 'key' }, 'hello', []);
      expect(result.thought).toBe('gemini done');
    });

    test('coder_tools write_file with missing content', async () => {
      const result = await handleCoderTool('write_file', { filePath: 'test.js' });
      expect(result).toContain('Error: "content" parameter is required.');
    });

    test('coder_tools write_file write error', async () => {
      const result = await handleCoderTool('write_file', { filePath: '/', content: '' });
      expect(result).toContain('Error writing file');
    });

    test('coder_tools list_dir directory not found error', async () => {
      const result = await handleCoderTool('list_dir', { dirPath: 'nonexistent_dir_123' });
      expect(result).toContain('Directory not found');
    });

    test('runAgentResponse with gemini provider', async () => {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const mockModel = {
        generateContent: jest.fn()
          .mockResolvedValueOnce({
            response: { text: () => JSON.stringify({ thought: 'done', tool: 'none' }) }
          })
          .mockResolvedValueOnce({
            response: { text: () => 'gemini report summary' }
          })
      };
      GoogleGenerativeAI.mockImplementation(() => ({
        getGenerativeModel: () => mockModel
      }));

      const { runWorkerAgent } = require('../utils/agents');
      const result = await runWorkerAgent('system_specialist', { provider: 'gemini', geminiKey: 'key' }, 'hello', null, 1);
      expect(result).toBe('{"status":"success","summary":"gemini report summary","data":{}}');
    });

    test('runAgentResponse with local lm-studio provider', async () => {
      const { runWorkerAgent } = require('../utils/agents');
      const globalFetch = global.fetch;
      let calls = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'done', tool: 'none' }) } }] })
          });
        } else {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: 'lm-studio report summary' } }] })
          });
        }
      });

      const result = await runWorkerAgent('system_specialist', { provider: 'local', localApiStyle: 'lm-studio', localBaseUrl: 'http://localhost' }, 'hello', null, 1);
      expect(result).toBe('{"status":"success","summary":"lm-studio report summary","data":{}}');
      global.fetch = globalFetch;
    });

    test('runAgentResponse with local anthropic provider', async () => {
      const { runWorkerAgent } = require('../utils/agents');
      const globalFetch = global.fetch;
      let calls = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ content: [{ text: JSON.stringify({ thought: 'done', tool: 'none' }) }] })
          });
        } else {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ content: [{ text: 'anthropic report summary' }] })
          });
        }
      });

      const result = await runWorkerAgent('system_specialist', { provider: 'local', localApiStyle: 'anthropic', localBaseUrl: 'http://localhost' }, 'hello', null, 1);
      expect(result).toBe('{"status":"success","summary":"anthropic report summary","data":{}}');
      global.fetch = globalFetch;
    });

    test('runAgentLoop with local lm-studio and anthropic providers', async () => {
      const mockThought = jest.fn();
      const mockContent = jest.fn();
      const mockToolCall = jest.fn();
      const globalFetch = global.fetch;
      
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Done', tool: 'none' }) } }] })
      });

      await runAgentLoop({
        provider: 'local',
        localApiStyle: 'lm-studio',
        localBaseUrl: 'http://localhost:1234',
        userMessage: 'hi',
        history: [],
        onThought: mockThought,
        onContent: mockContent,
        onToolCall: mockToolCall
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          content: [{ text: JSON.stringify({ thought: 'Done', tool: 'none' }) }],
          choices: [{ message: { content: JSON.stringify({ thought: 'Done', tool: 'none' }) } }]
        })
      });

      await runAgentLoop({
        provider: 'local',
        localApiStyle: 'anthropic',
        localBaseUrl: 'http://localhost:1234',
        userMessage: 'hi',
        history: [],
        onThought: mockThought,
        onContent: mockContent,
        onToolCall: mockToolCall
      });

      global.fetch = globalFetch;
    });

    test('runWorkerAgent routes specific actions (calendar create/update/delete)', async () => {
      const globalFetch = global.fetch;
      let calls = 0;
      global.fetch = jest.fn().mockImplementation((url) => {
        const urlStr = url || '';
        if (urlStr.includes('chat/completions') || urlStr.includes('completions')) {
          calls++;
          if (calls === 1) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Calendar actions', tool: 'calendar', action: 'create', params: { title: 'Meeting' } }) } }] })
            });
          } else if (calls === 2) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Calendar update', tool: 'calendar', action: 'update', params: { id: 1 } }) } }] })
            });
          } else if (calls === 3) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Calendar delete', tool: 'calendar', action: 'delete', params: { id: 1 } }) } }] })
            });
          } else {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: 'Combined report' } }] })
            });
          }
        }
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ choices: [], results: [] })
        });
      });

      const mockDb = {
        all: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null),
        run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 })
      };

      const result = await runWorkerAgent('calendar_handler', { provider: 'openai', modelName: 'gpt-4' }, 'Manage calendar actions', mockDb, 1);
      expect(result).toContain('Combined report');
      global.fetch = globalFetch;
    });

    test('runAgentTurn and runAgentResponse catch blocks on invalid URL', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'done', tool: 'none' }) } }] })
      });

      const result1 = await runAgentTurn('supervisor', 'system prompt', { provider: 'local', localBaseUrl: ':invalid_url' }, 'hello', []);
      expect(result1.thought).toBe('done');

      const result2 = await runWorkerAgent('system_specialist', { provider: 'local', localBaseUrl: ':invalid_url' }, 'hello', null, 1);
      expect(result2).toContain('done');

      global.fetch = globalFetch;
    });

    test('runWorkerAgent handles loop error', async () => {
      const globalFetch = global.fetch;
      global.fetch = jest.fn().mockImplementation(() => {
        throw new Error('LLM connection failed');
      });
      await expect(
        runWorkerAgent('system_specialist', { provider: 'openai' }, 'hello', null, 1)
      ).rejects.toThrow('LLM connection failed');
      global.fetch = globalFetch;
    });

    test('runAgentLoop delegation subtask branch coverage', async () => {
      const mockThought = jest.fn();
      const mockContent = jest.fn();
      const mockToolCall = jest.fn();
      const globalFetch = global.fetch;

      const agents = ['web_searcher', 'calendar_handler', 'coder', 'qa_engineer', 'system_specialist', 'unknown_agent'];
      for (const agent of agents) {
        let calls = 0;
        global.fetch = jest.fn().mockImplementation(() => {
          calls++;
          if (calls === 1) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Delegating', tool: `delegate_to_${agent}`, params: { query: 'test', task: 'test' } }) } }] })
            });
          } else if (calls === 2) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Done', tool: 'none' }) } }] })
            });
          } else if (calls === 3) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Done', tool: 'none' }) } }] })
            });
          } else {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: 'Agent complete summary' } }] })
            });
          }
        });

        await runAgentLoop({
          provider: 'openai',
          modelName: 'gpt-4',
          userMessage: 'Delegation test',
          history: [],
          onThought: mockThought,
          onContent: mockContent,
          onToolCall: mockToolCall
        });
      }

      global.fetch = globalFetch;
    });

    test('runAgentLoop delegation failure handling', async () => {
      const mockThought = jest.fn();
      const mockContent = jest.fn();
      const mockToolCall = jest.fn();
      const globalFetch = global.fetch;

      let calls = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Delegating', tool: 'delegate_to_weather_expert' }) } }] })
          });
        } else if (calls === 2) {
          throw new Error('Worker execution failed');
        } else if (calls === 3) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Done', tool: 'none' }) } }] })
          });
        } else {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: 'Delegation failed summary' } }] })
          });
        }
      });

      await runAgentLoop({
        provider: 'openai',
        modelName: 'gpt-4',
        userMessage: 'Delegation fail test',
        history: [],
        onThought: mockThought,
        onContent: mockContent,
        onToolCall: mockToolCall
      });

      global.fetch = globalFetch;
    });

    test('runAgentLoop supervisor direct fallback tools', async () => {
      const mockThought = jest.fn();
      const mockContent = jest.fn();
      const mockToolCall = jest.fn();
      const globalFetch = global.fetch;

      const directTools = ['memory', 'time', 'unrecognized_tool'];
      for (const tool of directTools) {
        global.fetch = jest.fn()
          .mockResolvedValueOnce({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Calling direct tool', tool, action: 'clean_expired', params: {} }) } }] })
          })
          .mockResolvedValueOnce({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Done', tool: 'none' }) } }] })
          })
          .mockResolvedValueOnce({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: 'Direct tool complete' } }] })
          });

        const mockDb = {
          all: jest.fn().mockResolvedValue([]),
          get: jest.fn().mockResolvedValue(null),
          run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        await runAgentLoop({
          db: mockDb,
          userId: 1,
          provider: 'openai',
          modelName: 'gpt-4',
          userMessage: 'Direct tool test',
          history: [],
          onThought: mockThought,
          onContent: mockContent,
          onToolCall: mockToolCall
        });
      }

      global.fetch = globalFetch;
    });

    test('runWorkerAgent routes memory tool', async () => {
      const globalFetch = global.fetch;
      let calls = 0;
      global.fetch = jest.fn().mockImplementation((url) => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Recalling memories', tool: 'memory', action: 'recall', params: { query: 'test' } }) } }] })
          });
        } else {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Finishing', tool: 'none' }) } }] })
          });
        }
      });

      const mockDb = {
        all: jest.fn().mockResolvedValue([{ id: 1, content: 'User likes chess', level: 'long-term' }]),
        get: jest.fn().mockResolvedValue(null)
      };

      const result = await runWorkerAgent('memory_agent', { provider: 'openai', modelName: 'gpt-4' }, 'Manage memories', mockDb, 1);
      expect(result).toBeDefined();
      global.fetch = globalFetch;
    });

    test('runSupervisorHandoff routes to correct worker and returns output', async () => {
      const globalFetch = global.fetch;

      // Worker (web_searcher) decides "tool: none" without ever calling search_web, which
      // now triggers a forced real search_web call (and its internal DuckDuckGo/Google/
      // Wikipedia scrape fetches) before the final response is generated. Route by URL so
      // the LLM chat-completion sequence stays correct regardless of how many extra
      // non-LLM fetch calls the forced search performs.
      let llmCallCount = 0;
      global.fetch = jest.fn((url) => {
        const isLlmCall = typeof url === 'string' && url.includes('/chat/completions');
        if (isLlmCall) {
          llmCallCount++;
          if (llmCallCount === 1) {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      intent: 'search',
                      refined_data: { query: 'apples' },
                      next_action: 'delegate_to_web_searcher'
                    })
                  }
                }]
              })
            });
          } else if (llmCallCount === 2) {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      thought: 'I will finish now',
                      tool: 'none',
                      action: '',
                      params: {}
                    })
                  }
                }]
              })
            });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({
                    status: 'success',
                    summary: 'Mocked worker agent response',
                    data: {}
                  })
                }
              }]
            })
          });
        }
        // Non-LLM fetch calls (the forced search_web scrape attempts) fail gracefully.
        return Promise.resolve({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
      });

      const mockDb = {
        all: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null),
        run: jest.fn().mockResolvedValue({ lastID: 1 })
      };

      const result = await runSupervisorHandoff(
        'What is the weather?',
        { provider: 'openai', modelName: 'gpt-4', userId: 1, db: mockDb },
        mockDb,
        1,
        'token'
      );

      expect(result.supervisor_decision).toBeDefined();
      expect(result.supervisor_decision.next_action).toBe('delegate_to_web_searcher');
      expect(result.worker_output).toBeDefined();
      
      global.fetch = globalFetch;
    });

    test('runAgentLoop intercepts Google Home device commands directly', async () => {
      jest.doMock('../tools/google_home_tool', () => ({
        handleGoogleHomeTool: jest.fn().mockResolvedValue(JSON.stringify({
          success: true,
          message: 'Mocked Google Assistant execution'
        }))
      }));

      const mockThought = jest.fn();
      const mockContent = jest.fn();
      const mockToolCall = jest.fn();
      const globalFetch = global.fetch;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          choices: [{ message: { content: 'Sure, I have turned off the office light! 💡' } }]
        })
      });

      const mockDb = {
        all: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null),
        run: jest.fn().mockResolvedValue({ lastID: 1 })
      };

      const { runAgentLoop } = require('../ai');
      await runAgentLoop({
        db: mockDb,
        userId: 1,
        provider: 'openai',
        modelName: 'gpt-4',
        userMessage: 'Turn off the office light',
        history: [],
        onThought: mockThought,
        onContent: mockContent,
        onToolCall: mockToolCall
      });

      expect(mockToolCall).toHaveBeenCalledWith({
        tool: 'google_home',
        action: 'send_command',
        params: { command: 'Turn off the office light' },
        agent: 'system_specialist'
      });
      expect(mockContent).toHaveBeenCalledWith("Action Complete");
      global.fetch = globalFetch;
      jest.dontMock('../tools/google_home_tool');
    });

  });

  // QW-4 (audit): the dynamic custom-tool pipeline (createRegistryTool -> validateRegistryTool
  // -> mountRegistryTool, covered by tool_manager.test.js) had never actually been exercised
  // through the real *invocation* path a live agent turn uses - the dispatch branch in
  // runWorkerAgent that requires() a freshly-mounted handler.js off disk and calls it. These
  // tests write a real file to backend/tools/dynamic/ (the same real path the dispatch code
  // reads, matching tool_manager.test.js's own precedent) and drive runWorkerAgent through it.
  //
  // Each test uses its own uniquely-named tool directory rather than sharing one. Node's
  // require() caches modules by resolved path for the life of the process, and Jest's own
  // module registry does not honor manual require.cache invalidation the way plain Node does
  // (confirmed directly: deleting require.cache[require.resolve(path)] and re-requiring under
  // Jest still returns the stale module, while the identical sequence in a standalone `node`
  // script correctly picks up the new file content) - so reusing one path across tests would
  // make later tests see whichever handler.js an earlier test happened to require first,
  // regardless of what was actually written to disk for that test.
  describe('runWorkerAgent - dynamic custom tool dispatch (end-to-end)', () => {
    const writtenDirs = [];

    afterEach(() => {
      for (const dir of writtenDirs.splice(0)) {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    function writeDynamicTool(toolName, handlerCode) {
      const dir = path.join(__dirname, '../tools/dynamic', toolName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'handler.js'), handlerCode);
      writtenDirs.push(dir);
    }

    // The tool's raw output text is embedded two JSON.stringify layers deep (once as a
    // "History Context" array serialized into a prompt string, and again as that whole
    // prompt becoming a "content" field in the outer request body) - naive substring
    // matching against the raw, doubly-escaped body is unreliable. Parse both layers back
    // out to get the literal observation text the handler's own output produced.
    function extractToolObservationText(body) {
      const parsed = JSON.parse(body);
      const userMsg = parsed.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('History Context'));
      const match = userMsg.content.match(/History Context: (\[[\s\S]*\])$/);
      const history = JSON.parse(match[1]);
      const toolMsg = history.find(h => h.role === 'user' && h.content.includes('Tool Output'));
      return toolMsg.content;
    }

    function mockToolThenFinish(toolDecision, finalText = 'Final summary') {
      let calls = 0;
      return jest.fn().mockImplementation((url) => {
        const urlStr = url || '';
        if (urlStr.includes('completions')) {
          calls++;
          if (calls === 1) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify(toolDecision) } }] })
            });
          } else if (calls === 2) {
            return Promise.resolve({
              ok: true,
              headers: { get: () => 'application/json' },
              json: async () => ({ choices: [{ message: { content: JSON.stringify({ thought: 'Done', tool: 'none' }) } }] })
            });
          }
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ choices: [{ message: { content: finalText } }] })
          });
        }
        return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [], results: [] }) });
      });
    }

    function dbWithManifest(toolName, manifest) {
      return {
        all: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockImplementation(async (query, params) => {
          if (query.includes('FROM installed_tools') && params && params[0] === toolName) {
            return manifest ? { manifest: JSON.stringify(manifest) } : null;
          }
          return null;
        })
      };
    }

    test('a freshly mounted dynamic tool is actually require()-d and invoked, receiving the documented (action, params, options) signature', async () => {
      const toolName = 'qw4_e2e_success';
      writeDynamicTool(toolName, `
        module.exports = {
          handleQw4E2eTool: async (action, params, options) => {
            return JSON.stringify({
              success: true,
              action,
              params,
              hasDb: !!(options && options.db),
              userId: options && options.userId
            });
          }
        };
      `);

      const manifest = { name: toolName, exported_function: 'handleQw4E2eTool' };
      const globalFetch = global.fetch;
      global.fetch = mockToolThenFinish({ thought: 'Using the dynamic tool', tool: toolName, action: 'ping', params: { host: 'example.com' } });

      const mockDb = dbWithManifest(toolName, manifest);
      const result = await runWorkerAgent('coder', { provider: 'openai', modelName: 'gpt-4' }, 'Ping example.com using the dynamic tool', mockDb, 42);

      // The real proof this pipeline works end-to-end: the handler's own JSON output made
      // it into the DB lookup call (confirming dispatch actually ran require() + invoke,
      // not a mock), and the second observation round-trip picked it up before finishing.
      expect(mockDb.get).toHaveBeenCalledWith(expect.stringContaining('FROM installed_tools'), [toolName]);
      expect(result).toContain('Final summary');
      // mock.calls records every fetch() invocation, not just completions calls (other
      // code paths may fetch too) - filter to completions calls before indexing, so
      // index 1 reliably means "the second decision-loop turn," not "the second fetch()."
      const completionsCalls = global.fetch.mock.calls.filter(([url]) => (url || '').includes('completions'));
      const observation = extractToolObservationText(completionsCalls[1][1].body);
      expect(observation).toContain('"hasDb":true');
      expect(observation).toContain('"userId":42');

      global.fetch = globalFetch;
    });

    test('a registered tool file with no matching installed_tools row fails with a clear error instead of crashing the loop', async () => {
      const toolName = 'qw4_e2e_missing_row';
      writeDynamicTool(toolName, 'module.exports = { handleQw4E2eTool: async () => "unused" };');

      const globalFetch = global.fetch;
      global.fetch = mockToolThenFinish({ thought: 'Using the dynamic tool', tool: toolName, action: 'ping', params: {} });

      const mockDb = dbWithManifest(toolName, null); // no installed_tools row for this tool
      const result = await runWorkerAgent('coder', { provider: 'openai', modelName: 'gpt-4' }, 'Ping using the dynamic tool', mockDb, 42);

      expect(result).toContain('Final summary');
      const completionsCalls = global.fetch.mock.calls.filter(([url]) => (url || '').includes('completions'));
      const observation = extractToolObservationText(completionsCalls[1][1].body);
      expect(observation).toContain(`Dynamic tool "${toolName}" is not registered in database.`);

      global.fetch = globalFetch;
    });

    test('a manifest pointing at an exported_function the handler module does not have fails with a clear error', async () => {
      const toolName = 'qw4_e2e_bad_export';
      writeDynamicTool(toolName, 'module.exports = { someOtherFunctionName: async () => "unused" };');

      const manifest = { name: toolName, exported_function: 'handleQw4E2eTool' };
      const globalFetch = global.fetch;
      global.fetch = mockToolThenFinish({ thought: 'Using the dynamic tool', tool: toolName, action: 'ping', params: {} });

      const mockDb = dbWithManifest(toolName, manifest);
      const result = await runWorkerAgent('coder', { provider: 'openai', modelName: 'gpt-4' }, 'Ping using the dynamic tool', mockDb, 42);

      expect(result).toContain('Final summary');
      const completionsCalls = global.fetch.mock.calls.filter(([url]) => (url || '').includes('completions'));
      const observation = extractToolObservationText(completionsCalls[1][1].body);
      expect(observation).toContain('Exported function "handleQw4E2eTool" not found in dynamic tool module');

      global.fetch = globalFetch;
    });
  });
});
