import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState, type ReactElement } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Button, Dialog, Field, Icon, useDialogLayer, type DialogProps } from '../src/react/index.js';

/** Holds a dialog open, and offers a button to open it again once it closes. */
function Harness({ startOpen = true, opener = 'Open dialog', ...props }: DialogProps & { startOpen?: boolean; opener?: string }): ReactElement {
  const [open, setOpen] = useState(startOpen);
  const close = () => {
    props.onClose();
    setOpen(false);
  };
  return (
    <div className="sb-dialog-frame">
      <Button onClick={() => setOpen(true)}>{opener}</Button>
      {open ? (
        <Dialog
          {...props}
          onClose={close}
          footer={
            props.footer ?? (
              <>
                <Button variant="ghost" onClick={close}>
                  Keep it
                </Button>
                <Button variant="danger" onClick={close}>
                  Cancel mission
                </Button>
              </>
            )
          }
        />
      ) : null}
    </div>
  );
}

/** A side panel on `useDialogLayer`: the hook brings focus and Escape behaviour, the markup is the caller's. */
function Drawer({ onClose }: { onClose: () => void }): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  useDialogLayer(panel, onClose, { initialFocus: '[data-autofocus]' });
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Run details"
        className="modal"
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, borderRadius: 0, maxHeight: 'none' }}
      >
        <div className="modal__head">
          <h2 className="modal__title">Run details</h2>
        </div>
        <div className="modal__body sb-stack">
          <span className="sb-row">
            <Icon name="clock" /> 4m 12s
          </span>
          <span className="sb-row">
            <Icon name="branch" /> feat/settings
          </span>
        </div>
        <div className="modal__foot">
          <Button data-autofocus onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Components/Dialog',
  component: Dialog,
  args: {
    title: 'Cancel this mission?',
    description: 'Running steps stop; their work so far is kept.',
    children: 'Nothing is deleted. You can start it again from the backlog.',
    wide: false,
    closeOnScrim: true,
    onClose: fn(),
  },
  argTypes: {
    title: { control: 'text' },
    description: { control: 'text' },
    children: { control: 'text' },
    footer: { control: false },
    initialFocus: { control: 'text' },
  },
  render: (args) => <Harness {...args} />,
  parameters: {
    layout: 'fullscreen',
    // Each example in its own frame on the docs page: an open dialog takes
    // focus and traps Tab, which must not happen to the page around it.
    docs: {
      story: { inline: false, height: '380px' },
      description: {
        component:
          'A modal dialog: `role="dialog"`, `aria-modal`, named by its title and described by its description. Focus moves in when it opens (to `[data-autofocus]` first), Tab stays inside, Escape closes only the topmost dialog, and focus returns to what opened it. Render it while open; unmount it to close. `useDialogLayer` gives a drawer or a palette the same behaviour.',
      },
    },
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Wide: Story = {
  args: {
    wide: true,
    title: 'Edit the plan',
    description: 'Every step, its worker and its gate.',
    children: (
      <div className="sb-stack">
        <Field label="Step 1">{(control) => <input className="input" defaultValue="Write the migration" {...control} />}</Field>
        <Field label="Step 2">{(control) => <input className="input" defaultValue="Update the settings screen" {...control} />}</Field>
      </div>
    ),
    footer: (
      <>
        <Button variant="ghost">Discard</Button>
        <Button variant="primary">Save plan</Button>
      </>
    ),
  },
};

/** For a dialog that holds unsaved input, a press on the scrim does nothing. */
export const NoScrimClose: Story = {
  args: { closeOnScrim: false, title: 'Unsaved changes', description: 'Pressing outside will not close this one.' },
};

/**
 * Focus moves in (to `[data-autofocus]`), Tab and Shift+Tab wrap inside,
 * Escape closes it, and focus goes back to the button that opened it.
 */
export const FocusTrap: Story = {
  args: {
    title: 'Rename the project',
    description: undefined,
    children: <Field label="Name">{(control) => <input className="input" data-autofocus defaultValue="tandemise-web" {...control} />}</Field>,
    footer: undefined,
  },
  render: (args) => <Harness {...args} startOpen={false} opener="Rename" />,
  play: async ({ canvasElement, args, step }) => {
    const canvas = within(canvasElement);
    const opener = canvas.getByRole('button', { name: 'Rename' });
    await step('opening moves focus to [data-autofocus]', async () => {
      await userEvent.click(opener);
      const dialog = await canvas.findByRole('dialog', { name: 'Rename the project' });
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Name' })).toHaveFocus());
    });
    await step('Tab wraps from the last control to the first', async () => {
      await userEvent.tab();
      await expect(canvas.getByRole('button', { name: 'Keep it' })).toHaveFocus();
      await userEvent.tab();
      await expect(canvas.getByRole('button', { name: 'Cancel mission' })).toHaveFocus();
      await userEvent.tab();
      await expect(canvas.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    });
    await step('Shift+Tab wraps from the first to the last', async () => {
      await userEvent.tab({ shift: true });
      await expect(canvas.getByRole('button', { name: 'Cancel mission' })).toHaveFocus();
    });
    await step('Escape closes it and focus returns to the opener', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
      await expect(opener).toHaveFocus();
    });
  },
};

/**
 * A closed disclosure inside a dialog: what it hides cannot take focus, so focus starts on its summary and the
 * trap counts the summary, not the hidden button (Chromium keeps boxes for a closed `<details>`).
 */
export const ClosedDisclosure: Story = {
  args: {
    title: 'Step details',
    description: undefined,
    children: (
      <details>
        <summary>Retry with more access</summary>
        <button type="button" className="btn">Retry with write access</button>
      </details>
    ),
    footer: undefined,
  },
  render: (args) => <Harness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('dialog', { name: 'Step details' });
    const summary = canvasElement.querySelector('summary') as HTMLElement;
    await waitFor(() => expect(summary).toHaveFocus());
    await userEvent.tab({ shift: true });
    await expect(canvas.getByRole('button', { name: 'Cancel mission' })).toHaveFocus();
    await userEvent.tab();
    await expect(summary).toHaveFocus();
  },
};

/** A confirm opened from a dialog: Escape closes only the topmost layer. */
export const Stacked: Story = {
  render: function Stacked() {
    const [confirming, setConfirming] = useState(false);
    const [open, setOpen] = useState(true);
    return (
      <div className="sb-dialog-frame">
        <Button onClick={() => setOpen(true)}>Open settings</Button>
        {open ? (
          <Dialog title="Project settings" onClose={() => setOpen(false)} footer={<Button onClick={() => setConfirming(true)}>Reset everything…</Button>}>
            Settings for tandemise-web.
          </Dialog>
        ) : null}
        {confirming ? (
          <Dialog
            title="Reset every setting?"
            description="This cannot be undone."
            onClose={() => setConfirming(false)}
            footer={
              <>
                <Button variant="ghost" data-autofocus onClick={() => setConfirming(false)}>
                  Keep them
                </Button>
                <Button variant="danger" onClick={() => setConfirming(false)}>
                  Reset
                </Button>
              </>
            }
          />
        ) : null}
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Reset everything…' }));
    await canvas.findByRole('dialog', { name: 'Reset every setting?' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog', { name: 'Reset every setting?' })).not.toBeInTheDocument());
    await expect(canvas.getByRole('dialog', { name: 'Project settings' })).toBeInTheDocument();
  },
};

/** `useDialogLayer` gives a drawer, a palette or any custom panel the same focus and Escape behaviour. */
export const UseDialogLayerDrawer: Story = {
  name: 'useDialogLayer (a drawer)',
  render: function DrawerStory() {
    const [open, setOpen] = useState(false);
    return (
      <div className="sb-dialog-frame">
        <Button onClick={() => setOpen(true)}>Show run details</Button>
        {open ? <Drawer onClose={() => setOpen(false)} /> : null}
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const opener = canvas.getByRole('button', { name: 'Show run details' });
    await userEvent.click(opener);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Close' })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(opener).toHaveFocus();
  },
};
