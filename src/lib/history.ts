import path from 'path';
import os from 'os';
import { getExecutor } from './executor';
import { PodmanConnection } from './nodes';

function getHistoryDir(connection?: PodmanConnection) {
    if (!connection || connection.Name === 'local') {
        return path.join(os.homedir(), '.servicebay', 'history');
    }
    return '.servicebay/history';
}

export interface HistoryEntry {
  timestamp: string;
  filename: string;
  path: string;
  displayDate: string;
}

export async function saveSnapshot(filename: string, content: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const historyDir = getHistoryDir(connection);
  const fileHistoryDir = path.join(historyDir, filename);
  
  await executor.mkdir(fileHistoryDir);

  // Check if content is identical to the latest snapshot
  try {
    const files = await executor.readdir(fileHistoryDir);
    const snapshots = files.filter(f => f.endsWith('.bak')).sort();
    
    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      const latestContent = await executor.readFile(path.join(fileHistoryDir, latestSnapshot));
      if (latestContent === content) {
        return; // Skip saving if identical
      }
    }
  } catch {
    // Ignore errors
  }
  
  const now = new Date();
  // Include milliseconds to avoid collisions when saving multiple snapshots in rapid succession
  const timestamp = now.toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\./g, '-').replace('Z', '');
  const snapshotPath = path.join(fileHistoryDir, `${timestamp}.bak`);
  
  await executor.writeFile(snapshotPath, content);
}

export async function getHistory(filename: string, connection?: PodmanConnection): Promise<HistoryEntry[]> {
  const executor = getExecutor(connection);
  const historyDir = getHistoryDir(connection);
  const fileHistoryDir = path.join(historyDir, filename);
  
  try {
    const files = await executor.readdir(fileHistoryDir);
    return files
      .filter(f => f.endsWith('.bak'))
      .map(f => {
        const timestamp = f.replace('.bak', '');
        // Format: 2025-12-31_16-00-00-123
        const parts = timestamp.split('_');
        if (parts.length < 2) return null;
        
        const date = parts[0];
        const timePart = parts[1];
        // timePart is 16-00-00-123
        const time = timePart.split('-').slice(0, 3).join(':');
        
        const displayDate = `${date} ${time}`;
        
        return {
            timestamp: timestamp,
            filename: filename,
            path: path.join(fileHistoryDir, f),
            displayDate: displayDate
        };
      })
      .filter((e): e is HistoryEntry => e !== null)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // Newest first
  } catch {
    return [];
  }
}

export async function getSnapshotContent(filename: string, timestamp: string, connection?: PodmanConnection): Promise<string> {
  const executor = getExecutor(connection);
  const historyDir = getHistoryDir(connection);
  const snapshotPath = path.join(historyDir, filename, `${timestamp}.bak`);
  return executor.readFile(snapshotPath);
}
