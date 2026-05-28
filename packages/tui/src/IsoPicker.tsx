/**
 * Ink panel for the FCoS ISO version-picker (#1238). Thin presentation layer
 * over isoPicker.ts + isoProbes.ts: lists local + per-stream/arch remote builds
 * with the host arch marked, pre-selects a sensible default, and reports the
 * chosen image back. The actual download of a remote pick is a shell-out the
 * entry runs after unmount (native coreos-installer progress), so this stays a
 * thin menu.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { defaultChoiceIndex, type IsoChoice } from './isoPicker';

export interface IsoPickerProps {
  /** Resolve the merged local+remote choice list and the host arch. */
  loadChoices: () => Promise<{ choices: IsoChoice[]; hostArch: string }>;
  onSelect: (choice: IsoChoice) => void;
  onCancel: () => void;
}

function ChoiceList({ choices, cursor }: { choices: IsoChoice[]; cursor: number }): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      {choices.map((choice, i) => (
        <Text key={`${choice.kind}-${i}`} color={i === cursor ? 'green' : undefined}>
          {i === cursor ? '❯ ' : '  '}
          {choice.label}
        </Text>
      ))}
    </Box>
  );
}

export function IsoPicker({ loadChoices, onSelect, onCancel }: IsoPickerProps): React.ReactElement {
  const [choices, setChoices] = useState<IsoChoice[] | null>(null);
  const [cursor, setCursor] = useState(0);

  const load = useCallback(() => {
    loadChoices().then(
      ({ choices: next, hostArch }) => {
        setChoices(next);
        setCursor(Math.max(0, defaultChoiceIndex(next, hostArch)));
      },
      () => setChoices([]),
    );
  }, [loadChoices]);

  useEffect(() => {
    load();
  }, [load]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (!choices || choices.length === 0) return;
    if (key.upArrow) setCursor(c => (c - 1 + choices.length) % choices.length);
    else if (key.downArrow) setCursor(c => (c + 1) % choices.length);
    else if (key.return) onSelect(choices[cursor]);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Choose a Fedora CoreOS ISO</Text>
      {choices === null ? (
        <Text color="gray">Fetching available builds…</Text>
      ) : choices.length === 0 ? (
        <Text color="yellow">No local ISOs and no remote stream metadata reachable.</Text>
      ) : (
        <>
          <ChoiceList choices={choices} cursor={cursor} />
          <Box marginTop={1}>
            <Text color="gray">↑/↓ to move · Enter to select · Esc to cancel</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
