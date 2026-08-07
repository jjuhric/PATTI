import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MemoryPane from './MemoryPane';
import * as exportUtils from '../utils/export';

vi.mock('../utils/export', () => ({
  exportAsCSV: vi.fn(),
  exportAsJSON: vi.fn()
}));

describe('MemoryPane Component Tests', () => {
  const defaultProps = {
    memories: [
      { id: 1, content: 'Likes apple pie', level: 'long-term', expires_at: null, created_at: '2026-06-30T12:00:00.000Z' },
      { id: 2, content: 'Buy coffee filters', level: 'short-term', expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), created_at: '2026-06-30T12:00:00.000Z' }
    ],
    onAddMemory: vi.fn(),
    onDeleteMemory: vi.fn()
  };

  test('renders memory lists and handles submission', () => {
    render(<MemoryPane {...defaultProps} />);
    
    // Check titles
    expect(screen.getByText('AI Memory Vault')).toBeInTheDocument();
    
    // Check rendered memories
    expect(screen.getByText('Likes apple pie')).toBeInTheDocument();
    expect(screen.getByText('Buy coffee filters')).toBeInTheDocument();
    expect(screen.getByText('Expires in 3 days')).toBeInTheDocument();

    // Fill form and submit
    const textInput = screen.getByPlaceholderText('e.g. I prefer dark mode, or I have a dog named Rusty.');
    fireEvent.change(textInput, { target: { value: 'Has a cat named Mittens' } });

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'long-term' } });

    const form = screen.getByPlaceholderText('e.g. I prefer dark mode, or I have a dog named Rusty.').closest('form');
    fireEvent.submit(form);

    expect(defaultProps.onAddMemory).toHaveBeenCalledWith({
      content: 'Has a cat named Mittens',
      level: 'long-term'
    });
  });

  test('handles short-term memory expiration formatting correctly', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const expired = new Date();
    expired.setDate(expired.getDate() - 1);

    const customMemories = [
      { id: 3, content: 'Plan Chicago trip', level: 'short-term', expires_at: tomorrow.toISOString() },
      { id: 4, content: 'Old meeting notes', level: 'short-term', expires_at: expired.toISOString() }
    ];

    render(<MemoryPane {...defaultProps} memories={customMemories} />);

    expect(screen.getByText('Expires tomorrow')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  test('handles custom expiration date and relative days selection', () => {
    const mockOnAddMemory = vi.fn();
    render(<MemoryPane {...defaultProps} onAddMemory={mockOnAddMemory} />);

    const textInput = screen.getByPlaceholderText('e.g. I prefer dark mode, or I have a dog named Rusty.');
    fireEvent.change(textInput, { target: { value: 'Vacation on July 15' } });

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'short-term-custom' } });

    // Expect date picker to be visible and set value
    const dateInput = screen.getByLabelText('Expiration Date');
    fireEvent.change(dateInput, { target: { value: '2026-07-15' } });

    const form = textInput.closest('form');
    fireEvent.submit(form);

    expect(mockOnAddMemory).toHaveBeenCalledWith({
      content: 'Vacation on July 15',
      level: 'short-term',
      expiresAt: new Date('2026-07-15').toISOString(),
      days: undefined
    });

    // Test relative day selection (e.g. 14 days)
    fireEvent.change(textInput, { target: { value: 'Short-term relative note' } });
    fireEvent.change(select, { target: { value: 'short-term-14' } });
    fireEvent.submit(form);

    expect(mockOnAddMemory).toHaveBeenCalledWith({
      content: 'Short-term relative note',
      level: 'short-term',
      expiresAt: undefined,
      days: 14
    });
  });

  test('renders empty list fallback messages', () => {
    render(<MemoryPane {...defaultProps} memories={[]} />);

    expect(screen.getByText(/No long-term memories stored yet/)).toBeInTheDocument();
    expect(screen.getByText(/No short-term memories stored yet/)).toBeInTheDocument();
  });

  test('calls onDeleteMemory when delete button clicked', () => {
    render(<MemoryPane {...defaultProps} />);

    const deleteButtons = screen.getAllByTitle('Forget this memory');
    expect(deleteButtons.length).toBe(2);

    fireEvent.click(deleteButtons[0]);
    expect(defaultProps.onDeleteMemory).toHaveBeenCalledWith(1);

    fireEvent.click(deleteButtons[1]);
    expect(defaultProps.onDeleteMemory).toHaveBeenCalledWith(2);
  });

  test('covers empty content validation and alternate short term durations', () => {
    const mockOnAddMemory = vi.fn();
    const { container } = render(<MemoryPane {...defaultProps} onAddMemory={mockOnAddMemory} />);
    
    const textInput = screen.getByPlaceholderText('e.g. I prefer dark mode, or I have a dog named Rusty.');
    const select = screen.getByRole('combobox');
    const form = textInput.closest('form');

    // 1. Submit empty content
    fireEvent.change(textInput, { target: { value: '' } });
    fireEvent.submit(form);
    expect(mockOnAddMemory).not.toHaveBeenCalled();

    // 2. Submit short-term-30
    fireEvent.change(textInput, { target: { value: 'Relative 30' } });
    fireEvent.change(select, { target: { value: 'short-term-30' } });
    fireEvent.submit(form);
    expect(mockOnAddMemory).toHaveBeenCalledWith({
      content: 'Relative 30',
      level: 'short-term',
      expiresAt: undefined,
      days: 30
    });

    // 3. Submit short-term-1
    fireEvent.change(textInput, { target: { value: 'Relative 1' } });
    fireEvent.change(select, { target: { value: 'short-term-1' } });
    fireEvent.submit(form);
    expect(mockOnAddMemory).toHaveBeenCalledWith({
      content: 'Relative 1',
      level: 'short-term',
      expiresAt: undefined,
      days: 1
    });

    // 4. Submit short-term-7
    fireEvent.change(textInput, { target: { value: 'Relative 7' } });
    fireEvent.change(select, { target: { value: 'short-term-7' } });
    fireEvent.submit(form);
    expect(mockOnAddMemory).toHaveBeenCalledWith({
      content: 'Relative 7',
      level: 'short-term',
      expiresAt: undefined,
      days: 7
    });

    // 5. Submit short-term-90
    fireEvent.change(textInput, { target: { value: 'Relative 90' } });
    fireEvent.change(select, { target: { value: 'short-term-90' } });
    fireEvent.submit(form);
    expect(mockOnAddMemory).toHaveBeenCalledWith({
      content: 'Relative 90',
      level: 'short-term',
      expiresAt: undefined,
      days: 90
    });

    // 6. Submit short-term-custom with no date
    fireEvent.change(textInput, { target: { value: 'No custom date' } });
    fireEvent.change(select, { target: { value: 'short-term-custom' } });
    fireEvent.submit(form);
    expect(mockOnAddMemory).toHaveBeenCalledWith({
      content: 'No custom date',
      level: 'short-term',
      expiresAt: undefined,
      days: undefined
    });
  });

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete across both memory lists.
  describe('bulk delete', () => {
    test('the bulk toolbar only appears once a memory is selected, sharing selection across both lists', () => {
      render(<MemoryPane {...defaultProps} />);
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Select memory: Likes apple pie'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Select memory: Buy coffee filters'));
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      expect(screen.getByText('Delete 2 memories')).toBeInTheDocument();
    });

    test('singular vs. plural wording on the delete button', () => {
      render(<MemoryPane {...defaultProps} />);
      fireEvent.click(screen.getByLabelText('Select memory: Likes apple pie'));
      expect(screen.getByText('Delete 1 memory')).toBeInTheDocument();
    });

    test('clicking the delete button calls onBulkDeleteMemories with the selected ids and a clear callback', () => {
      const mockBulkDelete = vi.fn();
      render(<MemoryPane {...defaultProps} onBulkDeleteMemories={mockBulkDelete} />);

      fireEvent.click(screen.getByLabelText('Select memory: Likes apple pie'));
      fireEvent.click(screen.getByLabelText('Select memory: Buy coffee filters'));
      fireEvent.click(screen.getByText('Delete 2 memories'));

      expect(mockBulkDelete).toHaveBeenCalledWith([1, 2], expect.any(Function));
    });

    test('"Clear selection" empties the selection and hides the toolbar', () => {
      render(<MemoryPane {...defaultProps} />);
      fireEvent.click(screen.getByLabelText('Select memory: Likes apple pie'));
      fireEvent.click(screen.getByText('Clear selection'));

      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Select memory: Likes apple pie')).not.toBeChecked();
    });

    test('selection is pruned when a selected memory disappears (e.g. after a delete)', () => {
      const { rerender } = render(<MemoryPane {...defaultProps} />);
      fireEvent.click(screen.getByLabelText('Select memory: Likes apple pie'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      rerender(<MemoryPane {...defaultProps} memories={defaultProps.memories.filter((m) => m.id !== 1)} />);
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });
  });

  // FEAT-4 (docs/REVIEW_2026-08-03.md): CSV/JSON export of every memory.
  describe('export', () => {
    beforeEach(() => {
      exportUtils.exportAsCSV.mockClear();
      exportUtils.exportAsJSON.mockClear();
    });

    test('no export buttons render when there are no memories', () => {
      render(<MemoryPane {...defaultProps} memories={[]} />);
      expect(screen.queryByText('CSV')).not.toBeInTheDocument();
      expect(screen.queryByText('JSON')).not.toBeInTheDocument();
    });

    test('Export CSV passes every memory (long-term and short-term together)', () => {
      render(<MemoryPane {...defaultProps} />);
      fireEvent.click(screen.getByText('CSV'));

      expect(exportUtils.exportAsCSV).toHaveBeenCalledWith(
        'patti-memories.csv',
        defaultProps.memories,
        expect.arrayContaining([expect.objectContaining({ key: 'content', label: 'Content' })])
      );
    });

    test('Export JSON passes the raw memory objects', () => {
      render(<MemoryPane {...defaultProps} />);
      fireEvent.click(screen.getByText('JSON'));

      expect(exportUtils.exportAsJSON).toHaveBeenCalledWith('patti-memories.json', defaultProps.memories);
    });
  });
});
