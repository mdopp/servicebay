'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Power } from 'lucide-react';
import ConfirmModal from '@/components/ConfirmModal';
import ServiceBayUpdateCard from '@/components/ServiceBayUpdateCard';
import { useToast } from '@/providers/ToastProvider';

/**
 * Settings → System updates tab.
 *
 * Composes the shared ServiceBay self-updater card (also rendered on Home —
 * #2082) with the OS-reinstall control. The reinstall block stays here (and
 * NOT on Home) because it is destructive/recovery-only — Home only carries
 * the routine update surfaces.
 */
export default function UpdatesSection() {
  const { addToast } = useToast();

  const [bootStatus, setBootStatus] = useState<{
    entries: Array<{ bootNum: string; name: string; active: boolean; description: string; current: boolean }>;
    candidates: Array<{ bootNum: string; name: string; active: boolean; description: string; current: boolean }>;
    bootNext: string | null;
    bootCurrent: string | null;
    bootOrder: string[];
  } | null>(null);
  const [isReinstallModalOpen, setIsReinstallModalOpen] = useState(false);
  const [armingBoot, setArmingBoot] = useState(false);
  const [cancellingBoot, setCancellingBoot] = useState(false);
  const [rebooting, setRebooting] = useState(false);

  const fetchBootStatus = async () => {
    try {
      const res = await fetch('/api/system/boot/usb-next');
      if (res.ok) {
        const data = await res.json();
        setBootStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch boot status:', e);
    }
  };

  const confirmReinstall = async () => {
    setIsReinstallModalOpen(false);
    setArmingBoot(true);
    try {
      const res = await fetch('/api/system/boot/usb-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reboot: true }),
      });
      if (res.ok) {
        addToast('success', 'USB Boot Armed', 'System is rebooting to USB installation medium...');
        setRebooting(true);
        setTimeout(() => { window.location.reload(); }, 8000);
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to arm USB Boot');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast('error', 'Boot Arming Failed', msg);
    } finally {
      setArmingBoot(false);
      fetchBootStatus();
    }
  };

  const cancelUsbBoot = async () => {
    setCancellingBoot(true);
    try {
      const res = await fetch('/api/system/boot/usb-next', {
        method: 'DELETE',
      });
      if (res.ok) {
        addToast('success', 'USB Boot Cancelled', 'One-shot BootNext cleared. SSD boot restored.');
        fetchBootStatus();
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to clear BootNext');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast('error', 'Cancellation Failed', msg);
    } finally {
      setCancellingBoot(false);
    }
  };

  const triggerManualReboot = async () => {
    setRebooting(true);
    try {
      const res = await fetch('/api/system/boot/usb-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reboot: true, bootNum: bootStatus?.bootNext || undefined }),
      });
      if (res.ok) {
        addToast('success', 'Rebooting', 'System reboot command sent...');
      } else {
        throw new Error('Failed to trigger reboot');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast('error', 'Reboot Failed', msg);
      setRebooting(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async boot-status fetch on mount
    fetchBootStatus();
  }, []);

  return (
    <>
      <ServiceBayUpdateCard />

      {/* Reinstall Operating System Section */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full mt-6">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
          <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-lg text-red-600 dark:text-red-400">
            <Power size={20} className={rebooting ? 'animate-pulse' : ''} />
          </div>
          <div>
            <h3 className="font-bold text-gray-900 dark:text-white">Operating System Reinstallation</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Reinstall or recover the base operating system</p>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            Configure the server to boot into a connected installation USB to perform a fresh operating system reinstallation.
            This process will clear the base system files, but your personal data and stack volumes will be preserved.
          </p>

          {/* Active BootNext Warning Banner */}
          {bootStatus?.bootNext && bootStatus.entries.some(e => e.bootNum === bootStatus.bootNext) ? (
            (() => {
              const armedEntry = bootStatus.entries.find(e => e.bootNum === bootStatus.bootNext);
              const armedDesc = armedEntry ? armedEntry.description : `Boot${bootStatus.bootNext}`;
              return (
                <div className="p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-pulse">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-bold text-amber-800 dark:text-amber-400">USB Installation Boot Armed</h4>
                      <p className="text-xs text-amber-700 dark:text-amber-500 mt-1">
                        The system is configured to boot from the installation USB next: <span className="font-semibold font-mono">{armedDesc} ({bootStatus.bootNext})</span>.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={cancelUsbBoot}
                      disabled={cancellingBoot || rebooting}
                      className="px-3 py-1.5 text-xs bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-400 rounded hover:bg-amber-100 dark:hover:bg-amber-900/30 transition disabled:opacity-50"
                    >
                      {cancellingBoot ? 'Cancelling...' : 'Cancel USB Boot'}
                    </button>
                    <button
                      onClick={triggerManualReboot}
                      disabled={cancellingBoot || rebooting}
                      className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 transition disabled:opacity-50"
                    >
                      {rebooting ? 'Rebooting...' : 'Reboot Now'}
                    </button>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {bootStatus?.candidates && bootStatus.candidates.length > 0 ? (
                  <span className="text-green-600 dark:text-green-400 font-medium">
                    ✓ Detected {bootStatus.candidates.length} bootable installation medium candidate(s).
                  </span>
                ) : (
                  <span className="text-amber-600 dark:text-amber-500 font-medium">
                    ⚠ No bootable USB installation media detected in UEFI boot entries. Plug in the USB to start.
                  </span>
                )}
              </div>
              <button
                onClick={() => setIsReinstallModalOpen(true)}
                disabled={armingBoot || rebooting || !bootStatus?.candidates || bootStatus.candidates.length === 0}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors shadow-sm font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Power size={16} />
                {armingBoot ? 'Arming...' : 'Arm USB Boot & Reinstall'}
              </button>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={isReinstallModalOpen}
        title="Reinstall Operating System"
        message="Are you sure you want to arm the next boot to use the installation USB? The system will reboot immediately to start the installation process."
        confirmText="Confirm & Reboot"
        onConfirm={confirmReinstall}
        onCancel={() => setIsReinstallModalOpen(false)}
      />
    </>
  );
}
