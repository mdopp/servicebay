import OperatePage from './OperatePage';

export default async function ServiceOperatePage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = await params;
  return <OperatePage name={decodeURIComponent(raw)} />;
}
