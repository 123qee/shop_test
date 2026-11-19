import type { JoomListingBucket } from './joom-listing';
import type { JoomReviewReasonKey } from './joom-review';
import type { CollectedProduct, EditableProduct, ProductGrouping, ProductRecord } from './types';

/** Cross-page filters and selections use this index; large media, variants and descriptions are fetched separately. */
export interface ProductIndexItem extends Pick<ProductRecord, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'editedAt' | 'joomProductId' | 'templateConfirmed' | 'languageRisk'> {
  collected: Pick<CollectedProduct, 'title' | 'source' | 'sourceProductId' | 'generatedSku' | 'store'>;
  edited: Pick<EditableProduct, 'sku' | 'title'> | null;
  grouping: ProductGrouping;
  qualityGrade?: NonNullable<ProductRecord['qualityScore']>['grade'];
  listingBuckets: JoomListingBucket[];
  hasShopListings: boolean;
  reviewReasons: JoomReviewReasonKey[];
}

export interface ProductListCard extends ProductIndexItem, Pick<ProductRecord,
  'templateId' | 'lastError' | 'lastSyncedAt' | 'joomInventory' | 'joomState' | 'joomHasActiveVersion' | 'joomIssues' | 'joomIssueDetails'> {
  listings: { shopId: string; bucket?: JoomListingBucket }[];
  score?: number;
  image?: string;
  price: number;
  currency: string;
  sourceImage?: string;
  imageCount: number;
  variantCount: number;
}

export interface CatalogIndexResponse {
  version: string;
  items?: ProductIndexItem[];
}

export interface ProductSortCandidate {
  id: string;
  source: CollectedProduct['source'];
  createdAt: string;
  templateId?: string;
  image?: string;
  suggestion?: { templateId: string; confidence: 'high' | 'low' };
}
