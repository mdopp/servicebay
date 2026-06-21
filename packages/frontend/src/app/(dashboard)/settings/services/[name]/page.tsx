import { redirect } from 'next/navigation';

export default async function ServiceOperateRedirect({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  redirect(`/services/${name}`);
}
