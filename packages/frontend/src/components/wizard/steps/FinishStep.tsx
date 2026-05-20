'use client';


import { CheckCircle, ArrowRight } from 'lucide-react';
import { Button } from '../WizardUI';

interface FinishStepProps {
    handleFinish: () => void;
}

export function FinishStep({ handleFinish }: FinishStepProps) {
    return (
        <div className="space-y-8 py-8 text-center animate-in fade-in zoom-in-95 duration-500">
            <div className="relative inline-block">
                <div className="absolute inset-0 bg-emerald-500/20 blur-3xl rounded-full"></div>
                <div className="relative p-6 rounded-3xl bg-emerald-500/10 border border-emerald-500/20">
                    <CheckCircle className="w-16 h-16 text-emerald-500" />
                </div>
            </div>
            
            <div className="space-y-3">
                <h3 className="text-3xl font-extrabold tracking-tight bg-clip-text text-transparent premium-gradient">
                    You&apos;re All Set!
                </h3>
                <p className="text-gray-600 dark:text-gray-400 max-w-md mx-auto leading-relaxed">
                    Your ServiceBay environment has been successfully configured. You can now access your dashboard and start managing your services.
                </p>
            </div>

            <div className="pt-4">
                <Button onClick={handleFinish} className="w-full sm:w-auto px-12 py-4 text-lg">
                    Go to Dashboard <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
            </div>
            
            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">
                Setup Complete · Welcome Home
            </p>
        </div>
    );
}
