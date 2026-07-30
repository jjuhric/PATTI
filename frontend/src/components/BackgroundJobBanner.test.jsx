import React from 'react';
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BackgroundJobBanner from './BackgroundJobBanner';

describe('BackgroundJobBanner Component Tests', () => {
  test('renders nothing when backgroundJob is null', () => {
    const { container } = render(<BackgroundJobBanner backgroundJob={null} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders the agent name and label when active', () => {
    render(<BackgroundJobBanner backgroundJob={{ agent: 'developer_agent', label: 'Writing index.js (3 of 10)...' }} />);
    expect(screen.getByText('developer_agent')).toBeInTheDocument();
    expect(screen.getByText('Writing index.js (3 of 10)...')).toBeInTheDocument();
  });

  test('falls back to sensible defaults when agent/label are missing', () => {
    render(<BackgroundJobBanner backgroundJob={{}} />);
    expect(screen.getByText('PATTI')).toBeInTheDocument();
    expect(screen.getByText('Working...')).toBeInTheDocument();
  });

  test('exposes a status role for accessibility', () => {
    render(<BackgroundJobBanner backgroundJob={{ agent: 'developer_agent', label: 'Planning...' }} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
