import { PodmanConnection } from './nodes';
import { AgentExecutor } from './agent/executor';
import { Executor } from './interfaces';

export type { Executor };

export function getExecutor(connectionInput?: PodmanConnection | string): Executor {
  let nodeName = 'Local';
  
  if (typeof connectionInput === 'string') {
      nodeName = connectionInput;
  } else if (connectionInput) {
      nodeName = connectionInput.Name;
  }
  
  // V4: Use AgentExecutor for everything (Local and Remote)
  return new AgentExecutor(nodeName);
}
