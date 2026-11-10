import type { FeatureEdit, OwnershipDoc, PlotRecord, Resolution } from '../types';

export type Persistence = 'file' | 'browser';

export interface LoadResult {
  doc: OwnershipDoc;
  persistence: Persistence;
  notice?: string;
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
}
