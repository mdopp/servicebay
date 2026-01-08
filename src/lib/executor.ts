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

// Deprecated classes kept for limited backward compatibility if imports exist
export class LocalExecutor extends AgentExecutor {
    constructor() {
        super('Local');
    }
}
export class SSHExecutor extends AgentExecutor {
    constructor(node: PodmanConnection) {
        super(node.Name);
    }
}
