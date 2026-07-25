import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SettingsModal from './SettingsModal';

describe('SettingsModal Component Tests', () => {
  const defaultSettings = {
    provider: 'local',
    model_name: 'qwen2.5-coder-7b-instruct',
    local_key: 'local_pwd',
    local_url: 'http://localhost:1234/v1',
    local_api_style: 'openai',
    online_url: '',
    online_key: '',
    online_provider: 'gemini'
  };

  const defaultProps = {
    isSettingsOpen: true,
    setIsSettingsOpen: vi.fn(),
    settings: defaultSettings,
    setSettings: vi.fn(),
    localModels: ['qwen2.5-coder-7b-instruct'],
    onlineModels: ['gemini-2.0-flash', 'gpt-4o', 'claude-3-5-sonnet-latest'],
    saveSettings: vi.fn(),
    showLocalKey: false,
    setShowLocalKey: vi.fn(),
    showOnlineKey: false,
    setShowOnlineKey: vi.fn()
  };

  test('does not render when closed', () => {
    const { container } = render(<SettingsModal {...defaultProps} isSettingsOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders Local LLM settings with a model dropdown populated from localModels', () => {
    render(<SettingsModal {...defaultProps} />);

    expect(screen.getByText('Local LLM Settings (Mandatory)')).toBeInTheDocument();
    const modelSelect = screen.getByDisplayValue('qwen2.5-coder-7b-instruct');
    expect(modelSelect).toBeInTheDocument();
    expect(modelSelect.tagName).toBe('SELECT');
  });

  test('falls back to a free-text model input when no local models have been scanned yet', () => {
    render(<SettingsModal {...defaultProps} localModels={[]} />);

    const modelInput = screen.getByPlaceholderText('e.g. qwen2.5-coder-7b-instruct');
    expect(modelInput).toBeInTheDocument();
    expect(modelInput.tagName).toBe('INPUT');
  });

  test('toggling Use Online Model Fallback checkbox shows/hides online settings', () => {
    render(<SettingsModal {...defaultProps} />);

    // Initial state: not checked, online settings should NOT be visible
    expect(screen.queryByText('Online Model Settings')).not.toBeInTheDocument();

    // Checkbox is clicked
    const checkbox = screen.getByRole('checkbox', { name: /Use Online Model Fallback/i });
    fireEvent.click(checkbox);

    // Online settings should now be visible
    expect(screen.getByText('Online Model Settings')).toBeInTheDocument();
  });

  test('triggers save configuration and triggers confirmation modal if provider is online', async () => {
    const mockSaveSettings = vi.fn();
    const onlineSettings = {
      ...defaultSettings,
      provider: 'online',
      online_key: 'online_pwd'
    };
    render(
      <SettingsModal 
        {...defaultProps} 
        settings={onlineSettings}
        saveSettings={mockSaveSettings}
      />
    );

    const saveBtn = screen.getByText('Save Configuration');
    fireEvent.click(saveBtn);

    // Confirmation dialog should appear
    expect(screen.getByText('Confirm Online Routing')).toBeInTheDocument();

    const confirmBtn = screen.getByText('Confirm');
    fireEvent.click(confirmBtn);
    expect(mockSaveSettings).toHaveBeenCalled();
  });

  test('modal close triggers', () => {
    const mockSetIsSettingsOpen = vi.fn();
    const { container } = render(
      <SettingsModal 
        {...defaultProps} 
        setIsSettingsOpen={mockSetIsSettingsOpen}
      />
    );

    const overlay = container.querySelector('.modal-overlay');
    fireEvent.click(overlay);
    expect(mockSetIsSettingsOpen).toHaveBeenCalledWith(false);
  });
});
