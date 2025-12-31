import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const HISTORY_DIR = path.join(os.homedir(), '.servicebay', 'history');

export interface HistoryEntry {
  timestamp: string;
  filename: string;
  path: string;
  displayDate: string;
}

export async function saveSnapshot(filename: string, content: string) {
  const fileHistoryDir = path.join(HISTORY_DIR, filename);
  
  await fs.mkdir(fileHistoryDir, { recursive: true });

  // Check if content is identical to the latest snapshot
  try {
    const files = await fs.readdir(fileHistoryDir);
    const snapshots = files.filter(f => f.endsWith('.bak')).sort();
    
    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      const latestContent = await fs.readFile(path.join(fileHistoryDir, latestSnapshot), 'utf-8');
      if (latestContent === content) {
        return; // Skip saving if identical
      }
    }
  } catch (e) {
    // Ignore errors
  }
  
  const now = new Date();
  const timestamp = now.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
  const snapshotPath = path.join(fileHistoryDir, `${timestamp}.bak`);
  
  await fs.writeFile(snapshotPath, content);
}

export async function getHistory(filename: string): Promise<HistoryEntry[]> {
  const fileHistoryDir = path.join(HISTORY_DIR, filename);
  
  try {
    const files = await fs.readdir(fileHistoryDir);
    return files
      .filter(f => f.endsWith('.bak'))
      .map(f => {
        const timestamp = f.replace('.bak', '');
        // Format: 2025-12-31_16-00-00
        const [date, time] = timestamp.split('_');
        const displayDate = `${date} ${time.replace(/-/g, ':')}`;
        
        return {
            timestamp: timestamp,
            filename: filename,
            path: path.join(fileHistoryDir, f),
            displayDate: displayDate
        };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // Newest first
  } catch {
    return [];
  }
}

export async function getSnapshotContent(filename: string, timestamp: string): Promise<string> {
  const snapshotPath = path.join(HISTORY_DIR, filename, `${timestamp}.bak`);
  return fs.readFile(snapshotPath, 'utf-8');
}
