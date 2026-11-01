import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { SkipLink } from '../src/react/index.js';

const meta = {
  title: 'Components/SkipLink',
  component: SkipLink,
  args: { target: 'skip-demo-main' },
  render: (args) => (
    <div style={{ position: 'relative', width: 480, minHeight: 200, border: '1px solid var(--border)' }}>
      <SkipLink {...args} />
      <nav aria-label="Demo navigation" className="sb-row" style={{ padding: 12, gap: 8 }}>
        <a href="#one">One</a>
        <a href="#two">Two</a>
        <a href="#three">Three</a>
      </nav>
      <div id="skip-demo-main" tabIndex={-1} style={{ padding: 12 }}>
        <p>The content a keyboard user wants to reach without tabbing through the navigation.</p>
        <button type="button" className="btn">First control in the content</button>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        component:
          'The first stop on every page (WCAG 2.4.1 Bypass Blocks). Hidden until it has keyboard focus, then it shows over the corner of the page; Enter moves focus to `target` (the page\'s `<main>`, with `tabIndex={-1}`). Focus moves by script, so it also works under a hash router.',
      },
    },
  },
} satisfies Meta<typeof SkipLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Tab shows it; Enter lands on the content, past the navigation. */
export const SkipsTheNavigation: Story = {
  play: async ({ canvas }) => {
    await userEvent.tab();
    const link = canvas.getByRole('link', { name: 'Skip to main content' });
    await expect(link).toHaveFocus();
    await expect(getComputedStyle(link).clipPath === 'none' || getComputedStyle(link).clip === 'auto').toBe(true);
    await userEvent.keyboard('{Enter}');
    await expect(document.getElementById('skip-demo-main')).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'First control in the content' })).toHaveFocus();
  },
};
