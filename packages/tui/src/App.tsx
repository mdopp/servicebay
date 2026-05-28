/**
 * Ink menu for the lifecycle launcher (#1231). Thin presentation layer over
 * phase.ts: detects the phase, renders the relevant actions, and reports a
 * terminal choice (build-iso / watch-install) back so the entry can hand off
 * to the bash legs. Quit and Refresh are handled in-component.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  detectPhase,
  actionsForPhase,
  describePhase,
  type MenuAction,
  type PhaseProbes,
  type PhaseState,
} from './phase';

export interface AppProps {
  probes: PhaseProbes;
  /** Called when the operator picks an action that hands off to a bash leg. */
  onChoose: (action: 'build-iso' | 'watch-install') => void;
}

function PhaseMenu({
  state,
  actions,
  cursor,
}: {
  state: PhaseState;
  actions: MenuAction[];
  cursor: number;
}): React.ReactElement {
  return (
    <>
      <Text color="cyan">{describePhase(state)}</Text>
      <Box marginTop={1} flexDirection="column">
        {actions.map((action, i) => (
          <Text key={action.id} color={i === cursor ? 'green' : undefined}>
            {i === cursor ? '❯ ' : '  '}
            {action.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑/↓ to move · Enter to select</Text>
      </Box>
    </>
  );
}

export function App({ probes, onChoose }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<PhaseState | null>(null);
  const [cursor, setCursor] = useState(0);

  // setState happens only in the promise callbacks, never synchronously in the
  // effect — that would trip react-hooks/set-state-in-effect.
  const loadPhase = useCallback(() => {
    detectPhase(probes).then(
      next => {
        setState(next);
        setCursor(0);
      },
      () => {
        setState({ phase: 'no-iso', isoBuilt: false, boxReachable: false, wizardDone: false });
        setCursor(0);
      },
    );
  }, [probes]);

  useEffect(() => {
    loadPhase();
  }, [loadPhase]);

  const actions: MenuAction[] = state ? actionsForPhase(state) : [];

  useInput((_input, key) => {
    if (!state || actions.length === 0) return;
    if (key.upArrow) setCursor(c => (c - 1 + actions.length) % actions.length);
    else if (key.downArrow) setCursor(c => (c + 1) % actions.length);
    else if (key.return) {
      const action = actions[cursor];
      if (action.id === 'quit') exit();
      else if (action.id === 'refresh') {
        setState(null);
        loadPhase();
      } else {
        onChoose(action.id);
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>ServiceBay — lifecycle launcher</Text>
      {state ? (
        <PhaseMenu state={state} actions={actions} cursor={cursor} />
      ) : (
        <Text color="gray">Detecting phase…</Text>
      )}
    </Box>
  );
}
