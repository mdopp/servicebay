/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ----------------------------------------------------------------------
// 1. Must Mock 'agentManager' and 'logger' before importing the API route
// ----------------------------------------------------------------------

// Create the mock object for agentManager
const mockAgent = {
    sendCommand: vi.fn(),
};

vi.mock('@/lib/agent/manager', () => ({
    agentManager: {
        getAgent: vi.fn(() => mockAgent)
    }
}));

// Mock Logger
vi.mock('@/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        error: vi.fn()
    }
}));

// ----------------------------------------------------------------------
// 2. Import the Handlers
// ----------------------------------------------------------------------
import { POST } from '../../src/app/api/containers/[id]/action/route';
import { GET } from '../../src/app/api/containers/route';

describe('Container API', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('POST /api/containers/[id]/action', () => {
        // Helper to create POST requests
        function createPostRequest(body: any, node?: string): NextRequest {
            const url = `http://localhost/api/containers/123/action${node ? '?node='+node : ''}`;
            return new NextRequest(url, {
                method: 'POST',
                body: JSON.stringify(body)
            });
        }

        it('should validate supported actions', async () => {
            const req = createPostRequest({ action: 'invalid_action' });
            const res = await POST(req, { params: Promise.resolve({ id: '123' }) });
            
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toMatch(/Invalid action/);
        });

        it('should execute restart command via Agent', async () => {
            const req = createPostRequest({ action: 'restart' });
            
            // Mock successful agent execution
            mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: 'Restarted', stderr: '' });

            const res = await POST(req, { params: Promise.resolve({ id: 'abc' }) });
            
            expect(res.status).toBe(200);
            expect(mockAgent.sendCommand).toHaveBeenCalledWith('exec', { 
                command: 'podman restart abc' 
            });
        });

        it('should handle deletion with force flag', async () => {
            const req = createPostRequest({ action: 'delete' });
            mockAgent.sendCommand.mockResolvedValueOnce({ code: 0 });

            const res = await POST(req, { params: Promise.resolve({ id: 'abc' }) });
            
            expect(mockAgent.sendCommand).toHaveBeenCalledWith('exec', { 
                command: 'podman rm -f abc' 
            });
            expect(res.status).toBe(200);
        });

        it('should return 500 if agent execution fails', async () => {
            const req = createPostRequest({ action: 'start' });
            mockAgent.sendCommand.mockResolvedValueOnce({ code: 1, stderr: 'No such container' });

            const res = await POST(req, { params: Promise.resolve({ id: 'abc' }) });
            
            expect(res.status).toBe(500);
            const data = await res.json();
            expect(data.error).toBe('Action failed');
        });

        it('should return 404 if agent is missing', async () => {
            // Force getAgent to return null
            const { agentManager } = await import('@/lib/agent/manager');
            (agentManager.getAgent as any).mockReturnValueOnce(null);

            const req = createPostRequest({ action: 'start' }, 'MissingNode');
            const res = await POST(req, { params: Promise.resolve({ id: 'abc' }) });
            
            expect(res.status).toBe(404);
        });
    });

    describe('GET /api/containers', () => {
        function createGetRequest(node?: string): NextRequest {
            const url = `http://localhost/api/containers${node ? '?node='+node : ''}`;
            return new NextRequest(url, { method: 'GET' });
        }

        it('should return list of containers from agent', async () => {
            const mockContainers = [{ id: '1', name: 'nginx' }];
            mockAgent.sendCommand.mockResolvedValueOnce(mockContainers);

            const req = createGetRequest();
            const res = await GET(req);

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data).toEqual(mockContainers);
            expect(mockAgent.sendCommand).toHaveBeenCalledWith('listContainers');
        });

        it('should return 500 on agent error', async () => {
            mockAgent.sendCommand.mockRejectedValueOnce(new Error('Agent Error'));

            const req = createGetRequest();
            const res = await GET(req);

            expect(res.status).toBe(500);
            const data = await res.json();
            expect(data.error).toBe('Agent Error');
        });
    });
});
