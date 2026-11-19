import type { FeatureEdit, OwnershipDoc, PlotRecord, Resolution } from '../types';

export type Persistence = 'file' | 'browser';

export interface LoadResult {
  doc: OwnershipDoc;
  persistence: Persistence;
  notice?: string;
}

/** What the app knows about the published data, for publishing from the deployed site. */
export interface PublishState {
  /** true on the deployed (static) site: there is no file API, results are published through /api/publish */
  canPublish: boolean;
  /** savedAt of the published version this browser's data was made from - what /api/publish is told */
  baseSavedAt: string | null;
  /** the published data as loaded with the page, or as last published from here; null when unknown */
  published: OwnershipDoc | null;
  /** true when the published data has changed since this browser's copy was made: publishing would be refused */
  diverged: boolean;
}

/**
 * Storage boundary for the ownership data. The UI only talks to this interface.
 * Each write call receives the specific change AND the full updated document:
 * a database implementation can use the change, a file implementation the document.
 */
export interface OwnershipRepository {
  load(): Promise<LoadResult>;
  savePlot(plotNumber: string, record: PlotRecord, doc: OwnershipDoc): Promise<Persistence>;
  saveResolution(reviewId: string, resolution: Resolution | null, doc: OwnershipDoc): Promise<Persistence>;
  /**
   * Shape edits (plot number / boundary) for one or more features; null removes an edit.
   * `recordMove` is set when renumbering a plot moves its ownership record.
   */
  saveFeatureEdits(
    edits: Record<string, FeatureEdit | null>,
    recordMove: { from: string; to: string } | null,
    doc: OwnershipDoc,
  ): Promise<Persistence>;
  replaceAll(doc: OwnershipDoc): Promise<Persistence>;
  publishState(): PublishState;
  /** The document was published: it is now the published version, and the base of the browser copy. */
  markPublished(doc: OwnershipDoc): void;
  /** Publishing was refused because newer data is published: remember it until the published data is loaded. */
  markConflict(): void;
  /** Removes the browser copy, so the next load shows the published data. */
  discardLocal(): void;
}
