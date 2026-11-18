import {z} from 'zod';

// Browser-only decoder: excluded from src/dist, which is pinned by model activation.
// Provider text and all other fields are deliberately stripped, never rendered.
export const CatalogueErrorCodeSchema=z.object({error:z.object({code:z.enum([
 'CATALOGUE_CONFLICT','CATALOGUE_SOURCE_CHANGED','CATALOGUE_SOURCE_UNAVAILABLE','CATALOGUE_INVALID',
])})});
