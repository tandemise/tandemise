import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { Field } from '../src/react/index.js';
import type { FieldControlProps } from '../src/react/index.js';

const meta = {
  title: 'Components/Field',
  component: Field,
  args: {
    label: 'Mission title',
    hint: 'What outcome do you want?',
    error: '',
    required: false,
    children: (control: FieldControlProps) => <input className="input" placeholder="Ship the settings page" {...control} />,
  },
  argTypes: {
    label: { control: 'text' },
    hint: { control: 'text' },
    error: { control: 'text' },
    children: { control: false },
  },
  decorators: [(Story) => <div className="sb-narrow">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'Label, control, and a hint or an error: the parts of one form question. Give it a node and it is a `<label>` wrapping the control. Give it a function and it renders `<label for>` and hands the control its `id`, `aria-describedby` (the hint, or the error) and `aria-invalid`, so a screen reader hears the error with the control.',
      },
    },
  },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithHint: Story = {
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: 'Mission title' });
    await expect(input).toHaveAccessibleDescription('What outcome do you want?');
    await expect(input).not.toHaveAttribute('aria-invalid');
  },
};

/** Keyboard focus draws the 2px focus ring around the control (WCAG 2.4.7, 1.4.11), not just a border hue change. */
export const FocusRing: Story = {
  play: async ({ canvas }) => {
    await userEvent.tab();
    const input = canvas.getByRole('textbox', { name: 'Mission title' });
    await expect(input).toHaveFocus();
    await expect(getComputedStyle(input).boxShadow).not.toBe('none');
  },
};

/** The error replaces the hint, marks the control invalid and describes it. */
export const WithError: Story = {
  args: { label: 'Done when', required: true, error: 'Say what done means.' },
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: /Done when/ });
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeRequired();
    await expect(input).toHaveAccessibleDescription('Say what done means.');
  },
};

export const Required: Story = { args: { label: 'Repository URL', required: true, hint: 'HTTPS or SSH.' } };

export const Disabled: Story = {
  args: {
    label: 'Branch',
    hint: 'Set by the mission; it cannot change once work started.',
    children: (control: FieldControlProps) => <input className="input" defaultValue="feat/settings" disabled {...control} />,
  },
};

/** The node form: a wrapping `<label>` names the control with no ids at all. */
export const WrappingLabel: Story = {
  args: { label: 'Repository', hint: undefined, children: undefined },
  render: (args) => (
    <Field {...args}>
      <select className="select" defaultValue="web">
        <option value="web">tandemise-web</option>
        <option value="desktop">tandemise-desktop</option>
      </select>
    </Field>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: 'Repository' })).toBeInTheDocument();
  },
};

export const Textarea: Story = {
  args: {
    label: 'Note for the next round',
    hint: 'The next round works from exactly what you write.',
    children: (control: FieldControlProps) => <textarea className="textarea" rows={4} {...control} />,
  },
  play: async ({ canvas }) => {
    const box = canvas.getByRole('textbox', { name: 'Note for the next round' });
    await userEvent.type(box, 'Keep the old route working.');
    await expect(box).toHaveValue('Keep the old route working.');
  },
};
