import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from './Sidebar';

describe('Sidebar Component Tests', () => {
  const defaultProps = {
    user: { username: 'testuser' },
    chats: [
      { id: 1, title: 'Chat One' },
      { id: 2, title: 'Chat Two' }
    ],
    activeChatId: 1,
    setActiveChatId: vi.fn(),
    activeTab: 'chat',
    setActiveTab: vi.fn(),
    isMobileSidebarOpen: false,
    setIsMobileSidebarOpen: vi.fn(),
    editingChatId: null,
    setEditingChatId: vi.fn(),
    editingTitle: '',
    setEditingTitle: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn(),
    handleRenameChat: vi.fn(),
    handleLogout: vi.fn(),
    setIsSettingsOpen: vi.fn(),
    setIsProfileOpen: vi.fn(),
    appVersion: '1.1.0'
  };

  test('renders user profile avatar block and chat list', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('👤 testuser')).toBeInTheDocument();
    expect(screen.getByText('Chat One')).toBeInTheDocument();
    expect(screen.getByText('Chat Two')).toBeInTheDocument();
  });

  test('triggers createChat on clicking New Chat button', () => {
    render(<Sidebar {...defaultProps} />);
    const newChatBtn = screen.getByText('New Chat');
    fireEvent.click(newChatBtn);
    expect(defaultProps.createChat).toHaveBeenCalled();
  });

  test('triggers setActiveTab when calendar button is clicked', () => {
    render(<Sidebar {...defaultProps} />);
    const calendarBtn = screen.getByText('My Calendar');
    fireEvent.click(calendarBtn);
    expect(defaultProps.setActiveTab).toHaveBeenCalledWith('calendar');
  });

  test('triggers setIsProfileOpen when clicking profile display', () => {
    render(<Sidebar {...defaultProps} />);
    const profileSpan = screen.getByText('👤 testuser');
    fireEvent.click(profileSpan);
    expect(defaultProps.setIsProfileOpen).toHaveBeenCalledWith(true);
  });

  test('triggers edit state, rename triggers, cancellations, and change propagation', () => {
    const mockSetEditingChatId = vi.fn();
    const mockSetEditingTitle = vi.fn();
    const mockHandleRenameChat = vi.fn();

    const { container, rerender } = render(
      <Sidebar 
        {...defaultProps} 
        setEditingChatId={mockSetEditingChatId}
        setEditingTitle={mockSetEditingTitle}
      />
    );

    const chatItem = container.querySelector('.chat-item.active');
    const buttons = chatItem.querySelectorAll('button');
    // First button inside the chat item is the Edit button
    fireEvent.click(buttons[0]);
    expect(mockSetEditingChatId).toHaveBeenCalledWith(1);
    expect(mockSetEditingTitle).toHaveBeenCalledWith('Chat One');

    // Rerender in editing state
    rerender(
      <Sidebar 
        {...defaultProps} 
        editingChatId={1}
        editingTitle="New Title"
        setEditingChatId={mockSetEditingChatId}
        setEditingTitle={mockSetEditingTitle}
        handleRenameChat={mockHandleRenameChat}
      />
    );

    const renameInput = screen.getByDisplayValue('New Title');
    expect(renameInput).toBeInTheDocument();

    // Change title
    fireEvent.change(renameInput, { target: { value: 'Different Title' } });

    // Click input should stop propagation
    fireEvent.click(renameInput);

    // Trigger Enter key
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    expect(mockHandleRenameChat).toHaveBeenCalledWith(1, 'New Title');

    // Trigger Escape key
    fireEvent.keyDown(renameInput, { key: 'Escape' });
    expect(mockSetEditingChatId).toHaveBeenCalledWith(null);

    // Trigger blur
    fireEvent.blur(renameInput);
    expect(mockHandleRenameChat).toHaveBeenCalledTimes(2);
  });

  test('triggers chat deletion, settings toggle, mobile close, and logout', () => {
    const mockDeleteChat = vi.fn();
    const mockHandleLogout = vi.fn();
    const mockSetIsSettingsOpen = vi.fn();
    const mockSetIsMobileSidebarOpen = vi.fn();

    const { container } = render(
      <Sidebar 
        {...defaultProps} 
        isMobileSidebarOpen={true}
        setIsMobileSidebarOpen={mockSetIsMobileSidebarOpen}
        deleteChat={mockDeleteChat}
        handleLogout={mockHandleLogout}
        setIsSettingsOpen={mockSetIsSettingsOpen}
      />
    );

    // Click mobile close button (in header close block)
    const mobileCloseBtn = container.querySelector('.btn-icon');
    fireEvent.click(mobileCloseBtn);
    expect(mockSetIsMobileSidebarOpen).toHaveBeenCalledWith(false);

    const chatItem = container.querySelector('.chat-item.active');
    const buttons = chatItem.querySelectorAll('button');
    // Second button inside chat-item is delete button
    fireEvent.click(buttons[1]);
    expect(mockDeleteChat).toHaveBeenCalled();

    // Selected by accessible name (I3) rather than position - the footer also
    // has a profile button and a theme toggle sharing this same button row.
    fireEvent.click(screen.getByLabelText('Open settings'));
    expect(mockSetIsSettingsOpen).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByLabelText('Log out'));
    expect(mockHandleLogout).toHaveBeenCalled();
  });

  test('theme toggle calls toggleTheme and reflects the current theme (I2)', () => {
    const mockToggleTheme = vi.fn();
    const { rerender } = render(<Sidebar {...defaultProps} theme="dark" toggleTheme={mockToggleTheme} />);

    const toggleBtn = screen.getByLabelText('Switch to light theme');
    fireEvent.click(toggleBtn);
    expect(mockToggleTheme).toHaveBeenCalled();

    rerender(<Sidebar {...defaultProps} theme="light" toggleTheme={mockToggleTheme} />);
    expect(screen.getByLabelText('Switch to dark theme')).toBeInTheDocument();
  });

  test('covers logo image error and AI Memory click', () => {
    const mockSetIsMobileSidebarOpen = vi.fn();
    const { container } = render(
      <Sidebar 
        {...defaultProps} 
        isMobileSidebarOpen={true}
        setIsMobileSidebarOpen={mockSetIsMobileSidebarOpen}
      />
    );

    // 1. Logo onError
    const logoImg = container.querySelector('.sidebar-logo');
    fireEvent.error(logoImg);
    expect(logoImg.src).toContain('placehold.co');

    // 2. AI Memory click
    const memoryBtn = screen.getByText('AI Memory');
    fireEvent.click(memoryBtn);
    expect(defaultProps.setActiveTab).toHaveBeenCalledWith('memory');
    expect(mockSetIsMobileSidebarOpen).toHaveBeenCalledWith(false);

    // 3. Agent Dashboard click
    const dashboardBtn = screen.getByText('Agent Dashboard');
    fireEvent.click(dashboardBtn);
    expect(defaultProps.setActiveTab).toHaveBeenCalledWith('dashboard');
    expect(mockSetIsMobileSidebarOpen).toHaveBeenCalledWith(false);
  });

  test('covers activeTab renders and editing chat click check', () => {
    const mockSetActiveChatId = vi.fn();
    const mockSetActiveTab = vi.fn();
    const { rerender } = render(
      <Sidebar 
        {...defaultProps} 
        activeTab="calendar"
        setActiveChatId={mockSetActiveChatId}
        setActiveTab={mockSetActiveTab}
      />
    );
    expect(screen.getByText('My Calendar').closest('button')).toHaveClass('active');

    rerender(
      <Sidebar 
        {...defaultProps} 
        activeTab="memory"
      />
    );
    expect(screen.getByText('AI Memory').closest('button')).toHaveClass('active');

    rerender(
      <Sidebar 
        {...defaultProps} 
        activeTab="dashboard"
      />
    );
    expect(screen.getByText('Agent Dashboard').closest('button')).toHaveClass('active');

    // Click chat item while editing it (should NOT activate/setActiveChatId)
    rerender(
      <Sidebar 
        {...defaultProps} 
        editingChatId={1}
        setActiveChatId={mockSetActiveChatId}
        setActiveTab={mockSetActiveTab}
      />
    );
    // The sidebar search box is also a textbox, so scope the query to a rename input that's
    // actually inside a .chat-item rather than assuming index 0 among all textboxes.
    const editingItem = document.querySelector('.chat-item input')?.closest('.chat-item');
    fireEvent.click(editingItem);
    expect(mockSetActiveChatId).not.toHaveBeenCalled();
  });

  // FEAT-2 (docs/REVIEW_2026-08-03.md): chat history search box + results.
  describe('chat search', () => {
    test('typing in the search box calls setChatSearchQuery', () => {
      const mockSetChatSearchQuery = vi.fn();
      render(<Sidebar {...defaultProps} setChatSearchQuery={mockSetChatSearchQuery} />);
      fireEvent.change(screen.getByPlaceholderText('Search chats...'), { target: { value: 'kubernetes' } });
      expect(mockSetChatSearchQuery).toHaveBeenCalledWith('kubernetes');
    });

    test('a query under 2 characters still shows the normal chat list, not search results', () => {
      render(<Sidebar {...defaultProps} chatSearchQuery="k" chatSearchResults={[{ chatId: 99, title: 'Should not show', snippet: '' }]} />);
      expect(screen.getByText('Chat One')).toBeInTheDocument();
      expect(screen.queryByText('Should not show')).not.toBeInTheDocument();
    });

    test('shows a "Searching..." status while a search is in flight', () => {
      render(<Sidebar {...defaultProps} chatSearchQuery="kubernetes" isSearchingChats={true} />);
      expect(screen.getByText('Searching…')).toBeInTheDocument();
      expect(screen.queryByText('Chat One')).not.toBeInTheDocument();
    });

    test('shows a no-results message when the search comes back empty', () => {
      render(<Sidebar {...defaultProps} chatSearchQuery="nothingmatches" chatSearchResults={[]} />);
      expect(screen.getByText('No chats found for "nothingmatches".')).toBeInTheDocument();
    });

    test('renders search results with title and snippet instead of the normal chat list', () => {
      render(
        <Sidebar
          {...defaultProps}
          chatSearchQuery="kubernetes"
          chatSearchResults={[
            { chatId: 5, title: 'Kubernetes notes', snippet: 'pod scheduling explained here' },
            { chatId: 6, title: 'Chat 9:00 AM', snippet: null }
          ]}
        />
      );
      expect(screen.getByText('Kubernetes notes')).toBeInTheDocument();
      expect(screen.getByText('pod scheduling explained here')).toBeInTheDocument();
      expect(screen.getByText('Chat 9:00 AM')).toBeInTheDocument();
      expect(screen.queryByText('Chat One')).not.toBeInTheDocument();
    });

    test('clicking a search result calls onOpenSearchResult with its chatId', () => {
      const mockOnOpenSearchResult = vi.fn();
      render(
        <Sidebar
          {...defaultProps}
          chatSearchQuery="kubernetes"
          chatSearchResults={[{ chatId: 5, title: 'Kubernetes notes', snippet: 'pod scheduling' }]}
          onOpenSearchResult={mockOnOpenSearchResult}
        />
      );
      fireEvent.click(screen.getByLabelText('Open chat "Kubernetes notes"'));
      expect(mockOnOpenSearchResult).toHaveBeenCalledWith(5);
    });

    test('the clear button only appears with a query and resets it', () => {
      const mockSetChatSearchQuery = vi.fn();
      const { rerender } = render(<Sidebar {...defaultProps} setChatSearchQuery={mockSetChatSearchQuery} />);
      expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();

      rerender(<Sidebar {...defaultProps} chatSearchQuery="kubernetes" setChatSearchQuery={mockSetChatSearchQuery} />);
      fireEvent.click(screen.getByLabelText('Clear search'));
      expect(mockSetChatSearchQuery).toHaveBeenCalledWith('');
    });
  });

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete for chats, behind a "Select chats" toggle.
  describe('bulk delete chats', () => {
    test('entering select mode shows a checkbox per chat and hides the rename/delete icons', () => {
      render(<Sidebar {...defaultProps} />);
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Select chats'));
      expect(screen.getAllByRole('checkbox')).toHaveLength(2);
      expect(screen.queryByLabelText('Rename chat "Chat One"')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Delete chat "Chat One"')).not.toBeInTheDocument();
    });

    test('clicking a chat row in select mode toggles its checkbox instead of opening the chat', () => {
      const mockSetActiveChatId = vi.fn();
      render(<Sidebar {...defaultProps} setActiveChatId={mockSetActiveChatId} />);
      fireEvent.click(screen.getByText('Select chats'));

      fireEvent.click(screen.getByLabelText('Select chat "Chat Two"'));
      expect(mockSetActiveChatId).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Select chat "Chat Two"')).toBeChecked();
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });

    test('the Delete button is disabled with nothing selected and calls onBulkDeleteChats once items are checked', () => {
      const mockOnBulkDeleteChats = vi.fn();
      render(<Sidebar {...defaultProps} onBulkDeleteChats={mockOnBulkDeleteChats} />);
      fireEvent.click(screen.getByText('Select chats'));

      expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();

      fireEvent.click(screen.getByLabelText('Select chat "Chat One"'));
      fireEvent.click(screen.getByLabelText('Select chat "Chat Two"'));
      expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(mockOnBulkDeleteChats).toHaveBeenCalledWith([1, 2], expect.any(Function));
    });

    test('Cancel exits select mode and clears the selection', () => {
      render(<Sidebar {...defaultProps} />);
      fireEvent.click(screen.getByText('Select chats'));
      fireEvent.click(screen.getByLabelText('Select chat "Chat One"'));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.getByText('Select chats')).toBeInTheDocument();
    });

    test('the select toggle is hidden while searching', () => {
      render(<Sidebar {...defaultProps} chatSearchQuery="kubernetes" chatSearchResults={[]} />);
      expect(screen.queryByText('Select chats')).not.toBeInTheDocument();
    });
  });
});
