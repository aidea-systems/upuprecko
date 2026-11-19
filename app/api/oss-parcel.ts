// Vercel function: GET /api/oss-parcel?parcelId=<number>, header X-Refresh-Token.
// All logic is in server/ossParcel.ts, which the Vite dev server mounts as well.
import { createNodeHandler } from '../server/ossParcel.js';

export const config = { maxDuration: 30 };

export default createNodeHandler(() => process.env.REFRESH_TOKEN);
