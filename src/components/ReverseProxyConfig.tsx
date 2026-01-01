'use client';

import { Shield, Download } from 'lucide-react';
import Link from 'next/link';

export default function ReverseProxyConfig() {
    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-white dark:bg-gray-900">
                <div className="flex flex-col">
                    <h2 className="font-bold text-xl text-gray-900 dark:text-white flex items-center gap-2">
                        <Shield className="text-green-500" />
                        Reverse Proxy
                    </h2>
                    <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
                        Source: <span className="font-mono">System</span>
                    </span>
                </div>
                <Link 
                    href="/registry?selected=nginx-web"
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors shadow-sm font-medium"
                >
                    <Download size={18} /> Install Nginx
                </Link>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-3xl">
                    <div className="mb-8 prose dark:prose-invert">
                        <p>
                            A Reverse Proxy is essential for routing traffic to your services. 
                            We recommend using <strong>Nginx</strong> as a robust and high-performance solution.
                        </p>
                        <p>
                            Installing the Nginx template will set up a web server that can be configured to proxy requests to your other containers.
                        </p>
                        
                        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mt-6">
                            <h3 className="text-lg font-semibold text-blue-800 dark:text-blue-300 mb-2">Why use a Reverse Proxy?</h3>
                            <ul className="list-disc list-inside space-y-1 text-blue-700 dark:text-blue-400">
                                <li>Single entry point for all your services</li>
                                <li>SSL/TLS termination for security</li>
                                <li>Load balancing capabilities</li>
                                <li>Clean URLs (no port numbers)</li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}