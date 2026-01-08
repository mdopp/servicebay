import { agentManager } from '../agent/manager';

export class FileManager {
  private static instance: FileManager;

  private constructor() {}

  public static getInstance(): FileManager {
    if (!FileManager.instance) {
      FileManager.instance = new FileManager();
    }
    return FileManager.instance;
  }

  async readFile(nodeName: string, path: string): Promise<string> {
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand('read_file', { path });
    // Assuming successful read returns string in result
    // My agent implementation returns error if file not found
    return res as string; 
  }

  async writeFile(nodeName: string, path: string, content: string): Promise<void> {
    const agent = await agentManager.ensureAgent(nodeName);
    await agent.sendCommand('write_file', { path, content });
  }
}

export const fileManager = FileManager.getInstance();
