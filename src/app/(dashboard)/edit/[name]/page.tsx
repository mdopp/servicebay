import ServiceForm from '@/components/ServiceForm';
import PageHeader from '@/components/PageHeader';
import { getServiceFiles } from '@/lib/manager';

export default async function EditPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  let initialData;
  
  try {
    const files = await getServiceFiles(name);
    const yamlFileName = files.yamlPath.split('/').pop() || 'pod.yml';
    
    initialData = {
      name,
      kubeContent: files.kubeContent,
      yamlContent: files.yamlContent,
      yamlFileName,
      serviceContent: files.serviceContent,
      kubePath: files.kubePath,
      yamlPath: files.yamlPath,
      servicePath: files.servicePath
    };
  } catch {
    return <div className="text-center mt-8 text-red-600">Service not found</div>;
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <PageHeader title={`Edit Service: ${name}`} />
      <div className="p-6">
        <ServiceForm initialData={initialData} isEdit />
      </div>
    </div>
  );
}
