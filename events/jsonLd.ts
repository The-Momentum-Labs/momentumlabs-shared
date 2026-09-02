/**
 * Structured data for the events page.
 *
 * Kept out of the component on purpose: JSON-LD belongs in <head>, and the head
 * is owned by each site's own layout. A site calls this in its frontmatter and
 * hands the result to its layout, so the markup stays shared while the canonical
 * URL and the organizer stay correct per site.
 */
import { eventsFor, type ProductKey } from './events.ts';

export type EventsJsonLdOptions = {
  /** Narrow to one product's events. Omit for every event. */
  product?: ProductKey;
  /** Origin of the site rendering the page, no trailing slash. */
  siteUrl: string;
  /** Organizer shown in the structured data. */
  orgName: string;
  /** Path the page is served at, e.g. '/events/'. */
  path: string;
};

export function eventsJsonLd({ product, siteUrl, orgName, path }: EventsJsonLdOptions): object[] {
  const pageUrl = new URL(path, siteUrl).href;
  return eventsFor(product).map((e) => ({
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: e.title,
    description: e.blurb,
    startDate: e.whenIso,
    endDate: e.endIso,
    eventAttendanceMode: e.format.toLowerCase().includes('person')
      ? 'https://schema.org/OfflineEventAttendanceMode'
      : 'https://schema.org/OnlineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: {
      '@type': 'Place',
      name: e.venue,
      address: {
        '@type': 'PostalAddress',
        streetAddress: e.address,
        addressLocality: e.city,
        addressRegion: e.state,
        postalCode: e.postalCode,
        addressCountry: 'US',
      },
    },
    organizer: { '@type': 'Organization', name: orgName, url: siteUrl },
    url: pageUrl,
  }));
}
