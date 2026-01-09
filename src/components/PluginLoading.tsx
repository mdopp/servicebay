import { RefreshCw } from 'lucide-react';

interface PluginLoadingProps {
  message?: string;
  subMessage?: string;
}

export default function PluginLoading({ message = "Waiting for data...", subMessage }: PluginLoadingProps) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-500 h-full min-h-[300px]">
            <div className="text-center">
                <RefreshCw className="animate-spin inline-block mb-3 text-blue-500 opacity-80" size={28} />
                <p className="font-medium text-gray-600 dark:text-gray-300">{message}</p>
                {subMessage && (
                    <p className="text-sm text-gray-400 mt-1">{subMessage}</p>
                )}
            </div>
        </div>
    );
}
