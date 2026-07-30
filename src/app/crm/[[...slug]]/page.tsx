import '../legacy-full-ui.css';

import { CrmApp } from '../CrmApp';
import { routeStateFromSlug } from '../route-map';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ slug?: string[] }>;
};

export default async function CrmPage({ params }: RouteContext) {
  const { slug } = await params;
  const { route, arg } = routeStateFromSlug(slug);

  return <CrmApp initialRoute={route} initialArg={arg} />;
}
