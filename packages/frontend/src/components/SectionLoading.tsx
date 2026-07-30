import { RefreshCw } from 'lucide-react';

interface SectionLoadingProps {
  message?: string;
  subMessage?: string;
}

export default function SectionLoading({ message = "Waiting for data...", subMessage }: SectionLoadingProps) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-text-subtle h-full min-h-[300px]">
            <div className="text-center">
                <RefreshCw className="animate-spin inline-block mb-3 text-accent opacity-80" size={28} />
                <p className="font-medium text-text-muted dark:text-text">{message}</p>
                {subMessage && (
                    <p className="text-sm text-text-muted mt-1">{subMessage}</p>
                )}
            </div>
        </div>
    );
}
