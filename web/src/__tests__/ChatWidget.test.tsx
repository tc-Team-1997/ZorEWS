import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatWidget } from '@/components/copilot/ChatWidget';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';
import { useChat } from '@/store/chat';

beforeEach(() => {
  // Each test starts with a clean conversation + closed panel.
  useChat.setState({
    open: false,
    sending: false,
    messages: [],
    error: null,
    context: { page: 'unknown' },
  });
});

describe('ChatWidget', () => {
  it('renders the launcher and keeps the panel hidden until clicked', () => {
    renderWithProviders(<ChatWidget />);
    expect(screen.getByTestId('chat-launcher')).toBeInTheDocument();
    const panel = screen.getByTestId('chat-panel');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens the panel on launcher click and shows the empty-state copy', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChatWidget />);
    await user.click(screen.getByTestId('chat-launcher'));
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByText(/Ask anything about risk/i)).toBeInTheDocument();
  });

  it('sends a message and renders the bot reply with suggestion chips', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChatWidget />);
    await user.click(screen.getByTestId('chat-launcher'));
    await user.type(screen.getByLabelText(/message/i), 'hello');
    await user.click(screen.getByLabelText(/send/i));

    await waitFor(() => {
      expect(screen.getByText(/I can see you|What can I help you with/i)).toBeInTheDocument();
    });
    // Default suggestions for unknown page should appear
    expect(screen.getByRole('button', { name: /what can you do/i })).toBeInTheDocument();
  });

  it('forwards page context (customer + facts) so the brain can quote PD', async () => {
    useChat.setState({
      context: {
        page: 'customer',
        entity: {
          type: 'customer',
          id: 'c-101',
          label: 'Acme Co',
          facts: { pd: 0.62, level: 'High' },
        },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<ChatWidget />);
    await user.click(screen.getByTestId('chat-launcher'));
    await user.type(screen.getByLabelText(/message/i), 'what is the PD?');
    await user.click(screen.getByLabelText(/send/i));

    expect(await screen.findByText(/Acme Co \(c-101\)/)).toBeInTheDocument();
    expect(screen.getByText(/62\.0%/)).toBeInTheDocument();
  });

  it('clicking a suggestion chip sends it as the next user message', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChatWidget />);
    await user.click(screen.getByTestId('chat-launcher'));

    // Trigger first reply so we get suggestion chips on screen.
    await user.type(screen.getByLabelText(/message/i), 'hi');
    await user.click(screen.getByLabelText(/send/i));
    await screen.findByRole('button', { name: /what can you do/i });

    await user.click(screen.getByRole('button', { name: /what can you do/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/what can you do/i).length).toBeGreaterThanOrEqual(1);
    });
    // Bot's help reply landed
    await waitFor(() => {
      expect(screen.getByText(/I can:/)).toBeInTheDocument();
    });
  });

  it('surfaces a 500 from the chat endpoint as an inline error', async () => {
    server.use(
      http.post('/v1/copilot/chat', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ChatWidget />);
    await user.click(screen.getByTestId('chat-launcher'));
    await user.type(screen.getByLabelText(/message/i), 'hi');
    await user.click(screen.getByLabelText(/send/i));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
