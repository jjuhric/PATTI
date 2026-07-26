import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SudoModal from './SudoModal';

describe('SudoModal Component Tests', () => {
  test('does not render when isOpen is false', () => {
    const { container } = render(
      <SudoModal 
        isOpen={false} 
        onClose={vi.fn()} 
        onSubmit={vi.fn()} 
        command="sudo systemctl restart patti" 
      />
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders form elements when open', () => {
    render(
      <SudoModal 
        isOpen={true} 
        onClose={vi.fn()} 
        onSubmit={vi.fn()} 
        command="sudo systemctl restart patti" 
      />
    );

    expect(screen.getByText('Elevated Privileges Required')).toBeInTheDocument();
    expect(screen.getByText('sudo systemctl restart patti')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
  });

  test('submits password correctly', () => {
    const mockOnSubmit = vi.fn();
    render(
      <SudoModal 
        isOpen={true} 
        onClose={vi.fn()} 
        onSubmit={mockOnSubmit} 
        command="sudo systemctl restart patti" 
      />
    );

    const input = screen.getByPlaceholderText('Enter password');
    fireEvent.change(input, { target: { value: 'mypassword123' } });

    const submitBtn = screen.getByText('Submit');
    fireEvent.click(submitBtn);

    expect(mockOnSubmit).toHaveBeenCalledWith('mypassword123');
  });

  test('renders User Account Control styling and interaction on Windows hosts', () => {
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();
    
    render(
      <SudoModal 
        isOpen={true} 
        onClose={mockOnClose} 
        onSubmit={mockOnSubmit} 
        command="write_file host_machine.js" 
        settings={{ device_type: 'windows' }}
      />
    );

    expect(screen.getByText('User Account Control')).toBeInTheDocument();
    expect(screen.getByText(/Do you want to allow this app to make changes/)).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();

    // Fill password
    const input = screen.getByPlaceholderText('Enter password');
    fireEvent.change(input, { target: { value: 'windowsadmin123' } });

    // Click Yes button to submit
    const yesBtn = screen.getByText('Yes');
    fireEvent.click(yesBtn);
    expect(mockOnSubmit).toHaveBeenCalledWith('windowsadmin123');

    // Click No button to close
    const noBtn = screen.getByText('No');
    fireEvent.click(noBtn);
    expect(mockOnClose).toHaveBeenCalled();
  });
});
