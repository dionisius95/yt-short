/**
 * Server component wrapper for the Export Queue page.
 *
 * Next.js static export requires `generateStaticParams` to be exported from a
 * Server Component (not a 'use client' file). Since project IDs are only known
 * at runtime from the local SQLite DB, we return an empty array and let the
 * client component read the actual ID via useParams().
 */
import ExportQueueClient from './ExportQueueClient';
// Tell Next.js not to error on unmatched dynamic params at build time.
// The actual [id] is resolved client-side via useParams().
export const dynamicParams = false;
export function generateStaticParams() {
    // Return a placeholder so Next.js generates the HTML shell.
    // The real project ID is read at runtime by the client component.
    return [{ id: '_' }];
}
export default function ExportQueuePage() {
    return <ExportQueueClient />;
}
