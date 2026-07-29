'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Template } from '@servicebay/api-client';
import { fetchReadme } from '@/app/actions';
import ReactMarkdown from 'react-markdown';
import { Download, Loader2, Folder, Layers, Server, Link as LinkIcon, Shield, FileCode } from 'lucide-react';
import InstallerModal from './InstallerModal';
import ExternalLinkConfig from './ExternalLinkConfig';
import ManualServiceForm from './ManualServiceForm';
import ReverseProxyConfig from './ReverseProxyConfig';
import ServiceForm from './ServiceForm';
import { Button } from '@/components/ui';

type SpecialItem = {
    id: string;
    name: string;
    description: string;
    icon: React.ReactNode;
    type: 'special';
    component?: React.ReactNode;
};

const specialItems: SpecialItem[] = [
    {
        id: 'proxy',
        name: 'Reverse Proxy',
        description: 'Nginx Proxy Manager',
        icon: <Shield size={18} className="text-status-ok" />,
        type: 'special',
        component: <ReverseProxyConfig />
    },
    {
        id: 'manual',
        name: 'Manual Service',
        description: 'Create from Docker image',
        icon: <Server size={18} className="text-accent" />,
        type: 'special',
        component: <ManualServiceForm />
    },
    {
        id: 'blank',
        name: 'Blank Quadlet',
        description: 'Edit kube YAML from scratch',
        icon: <FileCode size={18} className="text-status-warn" />,
        type: 'special',
        component: <ServiceForm variant="embedded" />
    },
    {
        id: 'link',
        name: 'External Link',
        description: 'Add shortcut to dashboard',
        icon: <LinkIcon size={18} className="text-muted" />,
        type: 'special',
        component: <ExternalLinkConfig />
    }
];

function RegistryListItem({ item, isSelected, onClick }: { item: Template; isSelected: boolean; onClick: () => void }) {
    return (
        <Button
            onClick={onClick}
            variant="ghost"
            className={`w-full h-auto justify-start text-left px-4 py-3 rounded-md flex items-center gap-3 transition-colors ${
                isSelected
                ? 'bg-surface ring-1 ring-border text-accent shadow-sm'
                : 'hover:bg-surface-2 text-foreground'
            }`}
        >
            {item.type === 'stack' ? (
                <Layers size={18} className={isSelected ? 'text-accent' : 'text-accent'} />
            ) : (
                <Folder size={18} className={isSelected ? 'text-accent' : 'text-subtle'} />
            )}
            <div className="flex flex-col items-start min-w-0 flex-1">
                <span className="font-medium truncate w-full">{item.name}</span>
                <span className="text-xs text-muted truncate w-full">{item.source}</span>
            </div>
            {item.type === 'stack' && <span className="text-xs bg-surface-2 text-accent px-2 py-0.5 rounded-full ml-auto">Stack</span>}
        </Button>
    );
}

export default function RegistryBrowser({ templates }: { templates: Template[] }) {
  const router = useRouter();
    const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Template | SpecialItem | null>(null);
  const [readme, setReadme] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Initialize selection
  useEffect(() => {
      const paramSelected = searchParams?.get('selected');
      if (paramSelected) {
          // Avoid re-setting if already selected
          if (selected) {
              const currentId = 'id' in selected ? selected.id : selected.name;
              if (currentId === paramSelected) return;
          }

          // Check special items first
          const special = specialItems.find(i => i.id === paramSelected);
          if (special) {
              // eslint-disable-next-line react-hooks/set-state-in-effect -- selects item from URL ?selected param; controlled URL→state sync
              setSelected(special);
              return;
          }
          // Check templates
          const tmpl = templates.find(t => t.name === paramSelected);
          if (tmpl) {
               
              setSelected(tmpl);
              return;
          }
      }

      if (!selected && templates.length > 0) {
           
          setSelected(templates[0]);
      }
  }, [templates, searchParams, selected]);

  useEffect(() => {
    if (selected && selected.type !== 'special') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async README fetch on selection change
      setLoading(true);
      fetchReadme(selected.name, selected.type, selected.source).then((content) => {
        setReadme(content || '# No README found');
        setLoading(false);
      });
    }
  }, [selected]);

  const handleSpecialClick = (item: SpecialItem) => {
      setSelected(item);
      router.push(`${pathname}?selected=${item.id}`);
  };

  const handleTemplateClick = (t: Template) => {
      setSelected(t);
      router.push(`${pathname}?selected=${t.name}`);
  };

  // Group the registry list so stacks sit together (internal + external) in
  // their own section, separate from single-service templates.
  const templateItems = templates.filter(t => t.type !== 'stack');
  const stackItems = templates.filter(t => t.type === 'stack');
  const isItemSelected = (t: Template) =>
      !!selected && !('id' in selected) && selected.name === t.name && selected.source === t.source;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar List */}
      <div className="w-80 flex-shrink-0 border-r border-border flex flex-col bg-surface-muted">
        <div className="overflow-y-auto flex-1 p-2 space-y-1">

            {/* Special Items Section */}
            <div className="mb-2 pb-2 border-b border-border">
                <div className="px-4 py-2 text-xs font-semibold text-muted uppercase tracking-wider">Create New</div>
                {specialItems.map(item => (
                    <Button
                        key={item.id}
                        onClick={() => handleSpecialClick(item)}
                        variant="ghost"
                        className={`w-full h-auto justify-start text-left px-4 py-3 rounded-md flex items-center gap-3 transition-colors ${
                            selected && 'id' in selected && selected.id === item.id
                            ? 'bg-surface ring-1 ring-border text-accent shadow-sm'
                            : 'hover:bg-surface-2 text-foreground'
                        }`}
                    >
                        {item.icon}
                        <div className="flex flex-col items-start min-w-0 flex-1">
                            <span className="font-medium truncate w-full">{item.name}</span>
                            <span className="text-xs text-muted truncate w-full">{item.description}</span>
                        </div>
                    </Button>
                ))}
            </div>

            {stackItems.length > 0 && (
                <>
                    <div className="px-4 py-2 text-xs font-semibold text-muted uppercase tracking-wider">Stacks</div>
                    {stackItems.map(t => (
                        <RegistryListItem key={`${t.source}-${t.name}`} item={t} isSelected={isItemSelected(t)} onClick={() => handleTemplateClick(t)} />
                    ))}
                </>
            )}

            {templateItems.length > 0 && (
                <>
                    <div className="px-4 py-2 mt-1 text-xs font-semibold text-muted uppercase tracking-wider">Templates</div>
                    {templateItems.map(t => (
                        <RegistryListItem key={`${t.source}-${t.name}`} item={t} isSelected={isItemSelected(t)} onClick={() => handleTemplateClick(t)} />
                    ))}
                </>
            )}

            {templates.length === 0 && (
                <div className="p-4 text-center text-muted text-sm">
                    No templates or stacks found in registry.
                </div>
            )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-surface">
        {selected ? (
            'id' in selected ? (
                // Render Special Item Component
                <div className="h-full overflow-y-auto">
                    {selected.component}
                </div>
            ) : (
                // Render Template Details
                <>
                    <div className="p-4 border-b border-border flex justify-between items-center bg-surface">
                        <div className="flex flex-col">
                            <h2 className="font-bold text-xl text-foreground flex items-center gap-2">
                                {selected.type === 'stack' && <Layers className="text-accent" />}
                                {selected.name}
                            </h2>
                            <span className="text-sm text-muted flex items-center gap-1">
                                Source: <span className="font-mono">{selected.source}</span>
                            </span>
                        </div>
                        <Button
                            onClick={() => setIsModalOpen(true)}
                            className="flex items-center gap-2 bg-accent text-on-accent px-4 py-2 rounded hover:bg-accent-strong transition-colors shadow-sm font-medium"
                        >
                            <Download size={18} /> Install {selected.type === 'stack' ? 'Stack' : 'Template'}
                        </Button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-8">
                        {loading ? (
                            <div className="flex items-center justify-center h-full text-subtle">
                                <Loader2 size={32} className="animate-spin" />
                            </div>
                        ) : (
                            <article className="prose prose-slate max-w-none dark:prose-invert mb-8">
                                <ReactMarkdown>{readme}</ReactMarkdown>
                            </article>
                        )}
                    </div>
                    
                    <InstallerModal 
                        template={selected} 
                        readme={readme} 
                        isOpen={isModalOpen} 
                        onClose={() => setIsModalOpen(false)} 
                    />
                </>
            )
        ) : (
            <div className="flex items-center justify-center h-full text-subtle">
                Select an item to view details
            </div>
        )}
      </div>
    </div>
  );
}
