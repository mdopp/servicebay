'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { checkOnboardingStatus, skipOnboarding, saveGatewayConfig, OnboardingStatus } from '@/app/actions/onboarding';
import { generateLocalKey } from '@/app/actions/ssh';

import { Loader2, Monitor, Network, Key, CheckCircle, ArrowRight, SkipForward } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

export default function OnboardingWizard() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(0); // 0: Check, 1: Welcome, 2: Gateway, 3: SSH, 4: Finish
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();
  const router = useRouter();

  // Gateway Form
  const [gwHost, setGwHost] = useState('fritz.box');
  const [gwUser, setGwUser] = useState('');
  const [gwPass, setGwPass] = useState('');

  useEffect(() => {
    checkOnboardingStatus().then(s => {
      setStatus(s);
      if (s.needsSetup) {
        setIsOpen(true);
        setStep(1);
      }
    });
  }, []);

  const handleSkip = async () => {
    await skipOnboarding();
    setIsOpen(false);
    addToast({ title: 'Setup Skipped', message: 'You can configure settings later in the System menu.', type: 'info' });
  };

  const handleSaveGateway = async () => {
    setLoading(true);
    try {
        await saveGatewayConfig(gwHost, gwUser, gwPass);
        addToast({ title: 'Gateway Saved', message: 'Connection settings saved.', type: 'success' });
        setStep(3);
    } catch {
        addToast({ title: 'Error', message: 'Failed to save gateway config', type: 'error' });
    } finally {
        setLoading(false);
    }
  };

  const handleFinish = async () => {
    await skipOnboarding(); // Mark as complete
    setIsOpen(false);
    router.refresh();
  };

  const handleGenerateKey = async () => {
    setLoading(true);
    try {
        const res = await generateLocalKey();
        if (res.success) {
            addToast({ title: 'Success', message: 'SSH Key generated.', type: 'success' });
            // Update status locally
             setStatus(prev => prev ? ({ ...prev, hasSshKey: true }) : null);
        } else {
             addToast({ title: 'Error', message: res.error || 'Failed to generate key', type: 'error' });
        }
    } catch {
        addToast({ title: 'Error', message: 'Failed call', type: 'error' });
    } finally {
        setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
           <h2 className="text-xl font-bold flex items-center gap-2">
             <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                <Monitor className="w-5 h-5 text-blue-600 dark:text-blue-400" />
             </div>
             ServiceBay Setup
           </h2>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto">
            {step === 1 && (
                <div className="space-y-4">
                    <p className="text-gray-600 dark:text-gray-300">
                        Welcome to ServiceBay! It looks like this is your first time here (or your configuration is missing).
                    </p>
                    <p className="text-gray-600 dark:text-gray-300">
                        Let&apos;s get your environment set up in a few simple steps.
                    </p>
                    <div className="grid grid-cols-1 gap-3 mt-4">
                        <div className="flex items-center gap-3 p-3 border rounded-lg bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700">
                            <Network className="w-5 h-5 text-purple-500" />
                            <div>
                                <div className="font-medium text-sm">Internet Gateway</div>
                                <div className="text-xs text-gray-500">Connect to FRITZ!Box for device tracking</div>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 p-3 border rounded-lg bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700">
                            <Key className="w-5 h-5 text-amber-500" />
                            <div>
                                <div className="font-medium text-sm">Remote Access</div>
                                <div className="text-xs text-gray-500">Generate SSH keys for node management</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {step === 2 && (
                <div className="space-y-4">
                     <h3 className="font-semibold text-lg">Internet Gateway</h3>
                     <p className="text-sm text-gray-500">
                        ServiceBay can inspect your FRITZ!Box to discover devices on your network.
                     </p>
                     
                     <div className="space-y-3 pt-2">
                        <div>
                            <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Hostname / IP</label>
                            <input 
                                type="text" 
                                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 outline-none"
                                value={gwHost}
                                onChange={(e) => setGwHost(e.target.value)}
                                placeholder="fritz.box"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Username</label>
                            <input 
                                type="text" 
                                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 outline-none"
                                value={gwUser}
                                onChange={(e) => setGwUser(e.target.value)}
                                placeholder="admin"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Password</label>
                            <input 
                                type="password" 
                                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 outline-none"
                                value={gwPass}
                                onChange={(e) => setGwPass(e.target.value)}
                            />
                        </div>
                     </div>
                </div>
            )}

            {step === 3 && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg">SSH Configuration</h3>
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                        {status?.hasSshKey 
                          ? "We found an existing SSH key. You are good to go!" 
                          : "No SSH key found. You can generate one now to enable remote node management."}
                    </p>
                    
                    {!status?.hasSshKey && (
                        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 rounded-lg text-sm">
                            Required for managing other servers or multi-node setups.
                        </div>
                    )}
                    
                    {!status?.hasSshKey && (
                        <div className="pt-2">
                             <Button onClick={handleGenerateKey} disabled={loading}>
                                {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                Generate SSH Key
                             </Button>
                        </div>
                    )}
                </div>
            )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center">
            {step === 1 ? (
                <button 
                  onClick={handleSkip}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1"
                >
                    <SkipForward className="w-4 h-4" /> Skip Setup
                </button>
            ) : (
                <button 
                  onClick={() => setStep(s => s - 1)}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                    Back
                </button>
            )}

            {step === 1 && (
                <Button onClick={() => setStep(2)}>
                    Get Started <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
            )}

            {step === 2 && (
                <div className="flex gap-2">
                    <button 
                        onClick={() => setStep(3)} // Skip gateway
                        className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
                    >
                        Skip
                    </button>
                    <Button onClick={handleSaveGateway} disabled={loading}>
                        {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Save & Continue
                    </Button>
                </div>
            )}

            {step === 3 && (
                <Button onClick={handleFinish}>
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Finish Setup
                </Button>
            )}
        </div>

      </div>
    </div>
  );
}

// Minimal Button component to reuse if needed, or import from UI lib
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

function Button({ children, onClick, disabled, className, ...props }: ButtonProps) {
    return (
        <button 
            onClick={onClick} 
            disabled={disabled}
            className={`px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium text-sm flex items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
            {...props}
        >
            {children}
        </button>
    )
}
