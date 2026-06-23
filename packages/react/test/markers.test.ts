import { describe, it, expect } from 'vitest';

import {
  START_MARKER_ID,
  END_MARKER_ID,
  START_EDGE_ID_PREFIX,
  END_EDGE_ID_PREFIX,
  startEdgeIdFor,
  endEdgeIdFor,
  isStartMarkerEdge,
  isEndMarkerEdge,
  isMarkerEdge,
  sourceLabelFromHandle,
} from '../src/lib/markers.js';

// The marker module is the single source of truth for the synthetic ids the
// canvas uses to render the (display-only) START/END nodes and their edges.
// These contracts are relied on by the serializer's stripMarkers round-trip, so
// they must be stable and internally consistent.
describe('marker id constants', () => {
  it('uses distinct, sentinel-looking ids for the two markers', () => {
    expect(START_MARKER_ID).toBe('__start__');
    expect(END_MARKER_ID).toBe('__end__');
    expect(START_MARKER_ID).not.toBe(END_MARKER_ID);
  });

  it('uses distinct prefixes for start and end marker edges', () => {
    expect(START_EDGE_ID_PREFIX).not.toBe(END_EDGE_ID_PREFIX);
  });
});

describe('startEdgeIdFor / endEdgeIdFor', () => {
  it('builds a start edge id by prefixing the target node id', () => {
    expect(startEdgeIdFor('nodeA')).toBe(`${START_EDGE_ID_PREFIX}nodeA`);
  });

  it('builds an end edge id by prefixing the source node id', () => {
    expect(endEdgeIdFor('nodeB')).toBe(`${END_EDGE_ID_PREFIX}nodeB`);
  });

  it('produces ids that round-trip through the matching detector', () => {
    expect(isStartMarkerEdge(startEdgeIdFor('x'))).toBe(true);
    expect(isEndMarkerEdge(endEdgeIdFor('x'))).toBe(true);
  });

  it('keeps start and end edge ids disjoint for the same node id', () => {
    const id = 'shared';
    expect(startEdgeIdFor(id)).not.toBe(endEdgeIdFor(id));
    expect(isEndMarkerEdge(startEdgeIdFor(id))).toBe(false);
    expect(isStartMarkerEdge(endEdgeIdFor(id))).toBe(false);
  });
});

describe('isStartMarkerEdge / isEndMarkerEdge / isMarkerEdge', () => {
  it('recognizes a start marker edge id', () => {
    expect(isStartMarkerEdge(`${START_EDGE_ID_PREFIX}foo`)).toBe(true);
    expect(isMarkerEdge(`${START_EDGE_ID_PREFIX}foo`)).toBe(true);
  });

  it('recognizes an end marker edge id', () => {
    expect(isEndMarkerEdge(`${END_EDGE_ID_PREFIX}foo`)).toBe(true);
    expect(isMarkerEdge(`${END_EDGE_ID_PREFIX}foo`)).toBe(true);
  });

  it('rejects an ordinary user edge id', () => {
    const userEdgeId = 'edge-123';
    expect(isStartMarkerEdge(userEdgeId)).toBe(false);
    expect(isEndMarkerEdge(userEdgeId)).toBe(false);
    expect(isMarkerEdge(userEdgeId)).toBe(false);
  });

  it('matches by prefix only at the start of the string', () => {
    // A user id that merely *contains* the prefix mid-string is not a marker.
    expect(isStartMarkerEdge(`x${START_EDGE_ID_PREFIX}y`)).toBe(false);
  });
});

describe('sourceLabelFromHandle', () => {
  it('maps branch-true to the "true" label', () => {
    expect(sourceLabelFromHandle('branch-true')).toBe('true');
  });

  it('maps branch-false to the "false" label', () => {
    expect(sourceLabelFromHandle('branch-false')).toBe('false');
  });

  it('returns undefined for a non-branch handle', () => {
    expect(sourceLabelFromHandle('source')).toBeUndefined();
  });

  it('returns undefined for null/undefined handles', () => {
    expect(sourceLabelFromHandle(null)).toBeUndefined();
    expect(sourceLabelFromHandle(undefined)).toBeUndefined();
  });
});
