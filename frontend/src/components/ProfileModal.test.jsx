import React from 'react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProfileModal from './ProfileModal';

describe('ProfileModal Component Tests', () => {
  const defaultProfile = {
    name: 'Jeffery Uhrick',
    zipcode: '32421',
    country: 'US',
    temp_unit: 'imperial',
    weather_api_key: 'test_key_123'
  };

  test('does not render when isProfileOpen is false', () => {
    const { container } = render(
      <ProfileModal 
        isProfileOpen={false} 
        setIsProfileOpen={vi.fn()} 
        profile={defaultProfile} 
        saveProfile={vi.fn()} 
      />
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders form elements and populates default data when open', () => {
    render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={vi.fn()} 
        profile={defaultProfile} 
        saveProfile={vi.fn()} 
      />
    );

    expect(screen.getByText('User Profile Settings')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your preferred name').value).toBe('Jeffery Uhrick');
    expect(screen.getByPlaceholderText('e.g. 32421').value).toBe('32421');
    expect(screen.getByPlaceholderText('US').value).toBe('US');
    expect(screen.getByDisplayValue('Imperial (°F, mph)')).toBeInTheDocument();
  });

  test('submits updated form values successfully', () => {
    const mockSaveProfile = vi.fn();
    const mockSetIsProfileOpen = vi.fn();

    const { container } = render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={mockSetIsProfileOpen} 
        profile={defaultProfile} 
        saveProfile={mockSaveProfile} 
      />
    );

    // Update inputs
    const nameInput = screen.getByPlaceholderText('Your preferred name');
    fireEvent.change(nameInput, { target: { value: 'New Name' } });

    const zipInput = screen.getByPlaceholderText('e.g. 32421');
    fireEvent.change(zipInput, { target: { value: '90210' } });

    const countryInput = screen.getByPlaceholderText('US');
    fireEvent.change(countryInput, { target: { value: 'gb' } });

    const tempSelect = screen.getByRole('combobox');
    fireEvent.change(tempSelect, { target: { value: 'metric' } });

    // Show/hide API key toggle
    const toggleBtn = container.querySelector('button[type="button"]');
    fireEvent.click(toggleBtn);

    const apiKeyInput = screen.getByPlaceholderText('Enter OpenWeatherMap API key');
    fireEvent.change(apiKeyInput, { target: { value: 'new_key' } });

    // Submit form
    const saveButton = screen.getByText('Save Profile');
    fireEvent.click(saveButton);

    expect(mockSaveProfile).toHaveBeenCalledWith({
      name: 'New Name',
      zipcode: '90210',
      country: 'GB',
      temp_unit: 'metric',
      weather_api_key: 'new_key',
      interests: [],
      favorite_teams: []
    });
  });

  test('trims leading/trailing whitespace from a pasted API key before saving', () => {
    const mockSaveProfile = vi.fn();

    const { container } = render(
      <ProfileModal
        isProfileOpen={true}
        setIsProfileOpen={vi.fn()}
        profile={defaultProfile}
        saveProfile={mockSaveProfile}
      />
    );

    const toggleBtn = container.querySelector('button[type="button"]');
    fireEvent.click(toggleBtn);

    const apiKeyInput = screen.getByPlaceholderText('Enter OpenWeatherMap API key');
    // Simulates a paste that carried a trailing newline/space, a common
    // copy-paste artifact that otherwise silently corrupts the key and
    // produces a 401 from the weather API later.
    fireEvent.change(apiKeyInput, { target: { value: '  abc123key  \n' } });
    expect(apiKeyInput.value).toBe('abc123key');

    fireEvent.click(screen.getByText('Save Profile'));
    expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({
      weather_api_key: 'abc123key'
    }));
  });

  test('modal close triggers', () => {
    const mockSetIsProfileOpen = vi.fn();
    const { container } = render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={mockSetIsProfileOpen} 
        profile={defaultProfile} 
        saveProfile={vi.fn()} 
      />
    );

    // Click overlay
    const overlay = container.querySelector('.modal-overlay');
    fireEvent.click(overlay);
    expect(mockSetIsProfileOpen).toHaveBeenCalledWith(false);

    // Click header close button
    const closeBtn = container.querySelector('.modal-header button');
    fireEvent.click(closeBtn);
    expect(mockSetIsProfileOpen).toHaveBeenCalledTimes(2);
  });

  test('handles missing profile or empty properties in profile', () => {
    const { rerender } = render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={vi.fn()} 
        profile={null} 
        saveProfile={vi.fn()} 
      />
    );
    expect(screen.getByPlaceholderText('Your preferred name').value).toBe('');

    rerender(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={vi.fn()} 
        profile={{ name: 'No Country' }} 
        saveProfile={vi.fn()} 
      />
    );
    expect(screen.getByPlaceholderText('US').value).toBe('US');
  });

  test('renders preferred models and saves settings when available', () => {
    const mockSaveSettings = vi.fn();
    const mockSaveProfile = vi.fn();
    const mockSettings = {
      local_url: 'http://localhost:1234/v1',
      online_key: 'test_online_key',
      preferred_local_model: 'qwen2.5-coder-7b-instruct',
      preferred_online_model: 'gemini-1.5-pro'
    };

    render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={vi.fn()} 
        profile={defaultProfile} 
        saveProfile={mockSaveProfile} 
        settings={mockSettings}
        saveSettings={mockSaveSettings}
        localModels={['qwen2.5-coder-7b-instruct']}
        onlineModels={['gemini-1.5-pro', 'gemini-2.5-flash']}
      />
    );

    fireEvent.click(screen.getByText('AI Models'));

    expect(screen.getByText('Preferred Local Model')).toBeInTheDocument();
    expect(screen.getByText('Preferred Online Model')).toBeInTheDocument();

    const localInput = screen.getByDisplayValue('qwen2.5-coder-7b-instruct');
    expect(localInput).toBeInTheDocument();
    expect(localInput).toHaveAttribute('readonly');

    const saveBtn = screen.getByText('Save Profile');
    fireEvent.click(saveBtn);

    expect(mockSaveProfile).toHaveBeenCalled();
  });

  test('handles escape keydown to close modal', () => {
    const mockSetIsProfileOpen = vi.fn();
    render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={mockSetIsProfileOpen} 
        profile={defaultProfile} 
        saveProfile={vi.fn()} 
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mockSetIsProfileOpen).toHaveBeenCalledWith(false);
  });

  test('renders preferred local model as read-only qwen2.5-coder-7b-instruct', () => {
    const mockSettings = {
      local_url: 'http://localhost:1234/v1'
    };

    render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={vi.fn()} 
        profile={defaultProfile} 
        saveProfile={vi.fn()} 
        settings={mockSettings}
        saveSettings={vi.fn()}
        localModels={[]}
        onlineModels={[]}
      />
    );

    fireEvent.click(screen.getByText('AI Models'));

    const input = screen.getByDisplayValue('qwen2.5-coder-7b-instruct');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('readonly');
  });

  test('handles online model preference changes', () => {
    const mockSaveSettings = vi.fn();
    const mockSettings = {
      online_key: 'some-key',
      preferred_online_model: 'gemini-1.5-pro'
    };

    render(
      <ProfileModal 
        isProfileOpen={true} 
        setIsProfileOpen={vi.fn()} 
        profile={defaultProfile} 
        saveProfile={vi.fn()} 
        settings={mockSettings}
        saveSettings={mockSaveSettings}
        localModels={[]}
        onlineModels={['gemini-1.5-pro', 'gpt-4o']}
      />
    );

    fireEvent.click(screen.getByText('AI Models'));

    const selects = screen.getAllByRole('combobox');
    const onlineSelect = selects.find(s => s.value === 'gemini-1.5-pro');
    fireEvent.change(onlineSelect, { target: { value: 'gpt-4o' } });

    fireEvent.click(screen.getByText('Save Profile'));
    expect(mockSaveSettings).toHaveBeenCalledWith(expect.objectContaining({
      preferred_online_model: 'gpt-4o'
    }));
  });

  test('handles personalization tab interactive interest lists', () => {
    const mockSaveProfile = vi.fn();
    render(
      <ProfileModal
        isProfileOpen={true}
        setIsProfileOpen={vi.fn()}
        profile={{
          ...defaultProfile,
          interests: ['AI']
        }}
        saveProfile={mockSaveProfile}
      />
    );

    // Switch to personalization tab
    fireEvent.click(screen.getByText('Personalization'));

    // Check pre-populated data
    expect(screen.getByText('AI')).toBeInTheDocument();

    // Add duplicate interest to cover duplicate check (lines 80-83)
    const interestInput = screen.getByPlaceholderText('Add an interest (e.g. AI News, Cycling)');
    fireEvent.change(interestInput, { target: { value: 'AI' } });
    const addBtn = screen.getByPlaceholderText('Add an interest (e.g. AI News, Cycling)').nextSibling;
    fireEvent.click(addBtn);

    // Add interest via Enter keypress (covers line 344)
    fireEvent.change(interestInput, { target: { value: 'Baking' } });
    fireEvent.keyDown(interestInput, { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(screen.getByText('Baking')).toBeInTheDocument();

    // Remove interest
    const removeBtn = screen.getAllByText('×')[0];
    fireEvent.click(removeBtn);
    expect(screen.queryByText('AI')).toBeNull();

    // Save profile
    fireEvent.click(screen.getByText('Save Profile'));
    expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({
      interests: ['Baking']
    }));
  });

  describe('Security tab (SEC-5 log out everywhere)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('clicking "Log out everywhere" asks for confirmation and calls onLogoutEverywhere when confirmed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const onLogoutEverywhere = vi.fn().mockResolvedValue();

      render(
        <ProfileModal
          isProfileOpen={true}
          setIsProfileOpen={vi.fn()}
          profile={defaultProfile}
          saveProfile={vi.fn()}
          onLogoutEverywhere={onLogoutEverywhere}
        />
      );

      fireEvent.click(screen.getByText('Security'));
      fireEvent.click(screen.getByText(/log out everywhere/i));

      expect(window.confirm).toHaveBeenCalled();
      await waitFor(() => expect(onLogoutEverywhere).toHaveBeenCalledTimes(1));
    });

    test('does not call onLogoutEverywhere when the confirmation is cancelled', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const onLogoutEverywhere = vi.fn();

      render(
        <ProfileModal
          isProfileOpen={true}
          setIsProfileOpen={vi.fn()}
          profile={defaultProfile}
          saveProfile={vi.fn()}
          onLogoutEverywhere={onLogoutEverywhere}
        />
      );

      fireEvent.click(screen.getByText('Security'));
      fireEvent.click(screen.getByText(/log out everywhere/i));

      expect(window.confirm).toHaveBeenCalled();
      expect(onLogoutEverywhere).not.toHaveBeenCalled();
    });

    test('the Security tab has no "Save Profile" button', () => {
      render(
        <ProfileModal
          isProfileOpen={true}
          setIsProfileOpen={vi.fn()}
          profile={defaultProfile}
          saveProfile={vi.fn()}
          onLogoutEverywhere={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText('Security'));
      expect(screen.queryByText('Save Profile')).toBeNull();
    });
  });
});
