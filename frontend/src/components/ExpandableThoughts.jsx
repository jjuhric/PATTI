import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export default function ExpandableThoughts({ thoughts, defaultExpanded = false }) {
  // RULE 4 ENFORCEMENT: Force initial state to false so thoughts always start collapsed
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Enforce collapsed baseline on message updates
    setExpanded(false);
  }, [thoughts]);

  if (!thoughts) return null;

  const cleanedThoughts = thoughts
    .replace(/<\|channel>thought/g, '')
    .replace(/<channel\|>/g, '')
    .replace(/<think>/g, '')
    .replace(/<\/think>/g, '')
    .replace(/Thinking Process:/gi, '')
    .trim();

  if (!cleanedThoughts) return null;

  return (
    <div className="thoughts-container">
      <div
        className="thoughts-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span>🧠 Agent Plan & Internal Thoughts</span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </div>
      {expanded && (
        <div className="thoughts-content">
          {cleanedThoughts}
        </div>
      )}
    </div>
  );
}
