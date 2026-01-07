'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { 
    checkOnboardingStatus, 
    skipOnboarding, 
    saveGatewayConfig, 
    saveAutoUpdateConfig,
    saveRegistriesConfig,
    saveEmailConfig,
    OnboardingStatus 
} from '@/app/actions/onboarding';
import { generateLocalKey } from '@/app/actions/ssh';

import { Loader2, Monitor, Network, Key, CheckCircle, ArrowRight, SkipForward, RefreshCw, Box, Mail } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

// Steps definition
type WizardStep = 'welcome' | 'gateway' | 'ssh' | 'updates' | 'registries' | 'email' | 'finish';

export default function OnboardingWizard() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');
  const [stepHistory, setStepHistory] = useState<WizardStep[]>([]);
  
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();
  const router = useRouter();

  // Selection Selection (Welcome Step)
  const [selection, setSelection] = useState({
    gateway: true,
    ssh: true,
    updates: false,
    registries: true,
    email: false
  });

  // Gateway Form
  const [gwHost, setGwHost] = useState('fritz.box');
  const [gwUser, setGwUser] = useState('');
  const [gwPass, setGwPass] = useState('');

  // Email Form
  const [emailConfig, setEmailConfig] = useState({
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      from: '',
      recipients: ''
  });

  useEffect(() => {
    checkOnboardingStatus().then(s => {
      setStatus(s);
      if (s.needsSetup) {
        setIsOpen(true);
        // Pre-fill selection based on detection/defaults
        setSelection(prev => ({
            ...prev,
            gateway: !s.features.gateway, // If not enabled, select it
            ssh: !s.features.ssh,
            updates: !s.features.updates,
            registries: !s.features.registries,
            email: !s.features.email
        }));
      }
    });
  }, []);

  const navigateTo = (step: WizardStep) => {
      setStepHistory(prev => [...prev, currentStep]);
      setCurrentStep(step);
  };

  const handleBack = () => {
    const prev = stepHistory[stepHistory.length - 1];
    if (prev) {
        setStepHistory(h => h.slice(0, -1));
        setCurrentStep(prev);
    }
  };

  const getNextStep = (current: WizardStep): WizardStep => {
      // Calculate next step based on selection
      const order: WizardStep[] = ['welcome', 'gateway', 'ssh', 'updates', 'registries', 'email', 'finish'];
      
      // Determine which steps are active based on selection
      const activeSteps = order.filter(step => {
         if (step === 'welcome' || step === 'finish') return true;
         return selection[step as keyof typeof selection]; 
      });

      const currentIndex = activeSteps.indexOf(current);
      if (currentIndex === -1 || currentIndex === activeSteps.length - 1) return 'finish';
      return activeSteps[currentIndex + 1];
  };

  const handleNext = () => {
      navigateTo(getNextStep(currentStep));
  };


  const handleSkip = async () => {
    await skipOnboarding();
    setIsOpen(false);
    addToast('info', 'Setup Skipped', 'You can configure settings later in the System menu.');
  };

  const saveAndNext = async (action: () => Promise<void>) => {
    setLoading(true);
    try {
        await action();
        handleNext(); // Move to next step if save success
    } catch {
        // Toast handled in action usually, or generic error here
        addToast('error', 'Error', 'Failed to save settings');
    } finally {
        setLoading(false);
    }
  };


  const handleFinish = async () => {
    await skipOnboarding(); // Mark as complete
    setIsOpen(false);
    router.refresh();
    addToast('success', 'Setup Complete', 'Welcome to ServiceBay!');
  };
  
  // -- Specific Save Handlers --

  const handleSaveGateway = () => saveAndNext(async () => {
     await saveGatewayConfig(gwHost, gwUser, gwPass);
     addToast('success', 'Gateway Saved');
  });

  const handleFinishSSH = () => {
     // SSH key generation is done inline, this just moves next
     handleNext();
  };

  const handleSaveUpdates = () => saveAndNext(async () => {
      await saveAutoUpdateConfig(true);
      addToast('success', 'Updates Enabled');
  });

  const handleSaveRegistries = () => saveAndNext(async () => {
      await saveRegistriesConfig(true);
      addToast('success', 'Registries Configured');
  });

  const handleSaveEmail = () => saveAndNext(async () => {
      await saveEmailConfig(emailConfig);
      addToast('success', 'Email Configured');
  });

  const handleGenerateKey = async () => {
    setLoading(true);
    try {
        const res = await generateLocalKey();
        if (res.success) {
            addToast('success', 'Success', 'SSH Key generated.');
            setStatus(prev => prev ? ({ ...prev, hasSshKey: true }) : null);
        } else {
             addToast('error', 'Error', res.error || 'Failed to generate key');
        }
    } catch {
        addToast('error', 'Error', 'Failed call');
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
            {currentStep === 'welcome' && (
                <div className="space-y-4">
                    <p className="text-gray-600 dark:text-gray-300">
                        Welcome to ServiceBay! Only a few steps to get your environment ready.
                    </p>
                    <p className="text-sm font-medium text-gray-500 uppercase tracking-wide">
                        What would you like to configure?
                    </p>
                    <div className="space-y-3">
                        {/* FEATURE TOGGLES */}
                        <Toggle 
                            checked={selection.gateway} 
                            onChange={(v: boolean) => setSelection(s => ({...s, gateway: v}))}
                            icon={Network} 
                            color="text-purple-500"
                            title="Internet Gateway" 
                            desc="Connect FRITZ!Box for device discovery"
                        />
                        <Toggle 
                            checked={selection.ssh} 
                            onChange={(v: boolean) => setSelection(s => ({...s, ssh: v}))}
                            icon={Key} 
                            color="text-amber-500"
                            title="Remote Access" 
                            desc="SSH keys for node management"
                        />
                        <Toggle 
                            checked={selection.updates} 
                            onChange={(v: boolean) => setSelection(s => ({...s, updates: v}))}
                            icon={RefreshCw} 
                            color="text-green-500"
                            title="Auto Updates" 
                            desc="Keep ServiceBay and containers updated"
                        />
                         <Toggle 
                            checked={selection.registries} 
                            onChange={(v: boolean) => setSelection(s => ({...s, registries: v}))}
                            icon={Box} 
                            color="text-blue-500"
                            title="Templates" 
                            desc="Enable GitHub template registries"
                        />
                        <Toggle 
                            checked={selection.email} 
                            onChange={(v: boolean) => setSelection(s => ({...s, email: v}))}
                            icon={Mail} 
                            color="text-red-500"
                            title="Notifications" 
                            desc="Email alerts for service health"
                        />
                    </div>
                </div>
            )}

            {currentStep === 'gateway' && (
                <div className="space-y-4">
                     <h3 className="font-semibold text-lg flex items-center gap-2"><Network className="w-5 h-5 text-purple-500"/> Internet Gateway</h3>
                     <p className="text-sm text-gray-500">
                        Enter your FRITZ!Box details to enable network scanning.
                     </p>
                     
                     <div className="space-y-3 pt-2">
                        <Input label="Hostname / IP" value={gwHost} onChange={setGwHost} placeholder="fritz.box" />
                        <Input label="Username" value={gwUser} onChange={setGwUser} placeholder="admin" />
                        <Input label="Password" type="password" value={gwPass} onChange={setGwPass} />
                     </div>
                </div>
            )}

            {currentStep === 'ssh' && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Key className="w-5 h-5 text-amber-500"/> SSH Configuration</h3>
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                        {status?.hasSshKey 
                          ? "We found an existing SSH key. You are good to go!" 
                          : "No SSH key found. Generate one now to enable management."}
                    </p>
                    
                    {!status?.hasSshKey && (
                        <div className="pt-2">
                             <Button onClick={handleGenerateKey} disabled={loading} className="w-full justify-center">
                                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Key className="w-4 h-4 mr-2" />}
                                Generate SSH Key
                             </Button>
                        </div>
                    )}
                </div>
            )}

            {currentStep === 'updates' && (
                 <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><RefreshCw className="w-5 h-5 text-green-500"/> Auto Updates</h3>
                    <p className="text-gray-600 dark:text-gray-300 text-sm">
                        Enable automatic updates for ServiceBay and your containers.
                        This will check for updates daily at midnight.
                    </p>
                    <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg text-sm text-blue-800 dark:text-blue-200">
                        <p className="font-medium">Podman Quadlets</p>
                        Your containers will be updated using <code>AutoUpdate=registry</code> mode.
                    </div>
                 </div>
            )}

            {currentStep === 'registries' && (
                 <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Box className="w-5 h-5 text-blue-500"/> Template Registries</h3>
                    <p className="text-gray-600 dark:text-gray-300 text-sm">
                        Enable the default ServiceBay template registry to install popular applications like Nginx, Redis, and more.
                    </p>
                     <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 text-sm font-mono text-gray-600 dark:text-gray-400">
                        https://github.com/mdopp/servicebay-templates
                    </div>
                 </div>
            )}

            {currentStep === 'email' && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Mail className="w-5 h-5 text-red-500"/> Email Notifications</h3>
                    <p className="text-sm text-gray-500">Configure SMTP settings for alerts.</p>
                     <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                             <Input label="SMTP Host" value={emailConfig.host} onChange={(v: string) => setEmailConfig(c => ({...c, host: v}))} placeholder="smtp.gmail.com" />
                             <Input label="Port" value={String(emailConfig.port)} onChange={(v: string) => setEmailConfig(c => ({...c, port: parseInt(v) || 587}))} placeholder="587" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                             <Input label="Username" value={emailConfig.user} onChange={(v: string) => setEmailConfig(c => ({...c, user: v}))} placeholder="user@example.com" />
                             <Input label="Password" type="password" value={emailConfig.pass} onChange={(v: string) => setEmailConfig(c => ({...c, pass: v}))} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                             <Input label="From Address" value={emailConfig.from} onChange={(v: string) => setEmailConfig(c => ({...c, from: v}))} placeholder="servicebay@example.com" />
                             <div className="flex items-end pb-2">
                                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                                    <input type="checkbox" checked={emailConfig.secure} onChange={e => setEmailConfig(c => ({...c, secure: e.target.checked}))} className="rounded border-gray-300" />
                                    Use SSL/TLS
                                </label>
                             </div>
                        </div>
                        <Input label="Recipients (comma separated)" value={emailConfig.recipients} onChange={(v: string) => setEmailConfig(c => ({...c, recipients: v}))} placeholder="admin@example.com" />
                     </div>
                </div>
            )}

            {currentStep === 'finish' && (
                 <div className="text-center py-8 space-y-4">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 mb-4">
                        <CheckCircle className="w-8 h-8" />
                    </div>
                    <h3 className="text-2xl font-bold">You&apos;re all set!</h3>
                    <p className="text-gray-600 dark:text-gray-300 max-w-sm mx-auto">
                        ServiceBay is configured and ready to use. Any settings can be changed later in the Settings menu.
                    </p>
                 </div>
            )}

        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center">
            {currentStep === 'welcome' ? (
                <button 
                  onClick={handleSkip}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1"
                >
                    <SkipForward className="w-4 h-4" /> Skip Setup
                </button>
            ) : (
                <button 
                  onClick={handleBack}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                    Back
                </button>
            )}

            {currentStep === 'welcome' && (
                <Button onClick={handleNext}>
                    Next <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
            )}

            {/* Step specific primary actions */}
            {currentStep === 'gateway' && <Button onClick={handleSaveGateway} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save & Next</Button>}
            {currentStep === 'ssh' && <Button onClick={handleFinishSSH}>Continue <ArrowRight className="w-4 h-4 ml-2"/></Button>}
            {currentStep === 'updates' && <Button onClick={handleSaveUpdates} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enable Updates</Button>}
            {currentStep === 'registries' && <Button onClick={handleSaveRegistries} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enable Registry</Button>}
            {currentStep === 'email' && <Button onClick={handleSaveEmail} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Email</Button>}
            
            {currentStep === 'finish' && (
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

// -- Helper Components --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Toggle({ checked, onChange, icon: Icon, color, title, desc }: any) {
    return (
        <div 
            onClick={() => onChange(!checked)}
            className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                checked 
                 ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800' 
                 : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
        >
            <div className={`mt-0.5 ${checked ? color : 'text-gray-400'}`}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
                <div className={`font-medium text-sm ${checked ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500'}`}>{title}</div>
                <div className="text-xs text-gray-500">{desc}</div>
            </div>
            <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300 dark:border-gray-600'
            }`}>
                {checked && <CheckCircle className="w-3.5 h-3.5 text-white" />}
            </div>
        </div>
    )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Input({ label, value, onChange, placeholder, type = 'text' }: any) {
   return (
      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{label}</label>
        <input 
            type={type}
            className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 outline-none text-sm"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
        />
    </div>
   )
}

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

