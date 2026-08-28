import { Route } from '@proteinjs/server-api';
import { getDbAsSystem } from '@proteinjs/db';
import { tables, UserAuth, getScopedDbAsSystem } from '@proteinjs/user';
import { FileStorage, File, tables as fileTables } from '@proteinjs/db-file';
import { Logger } from '@proteinjs/logger';

const logger = new Logger({ name: 'avatarRoute' });

/**
 * Shared avatar serving: `GET /avatar/:userId?v=<avatarFileId>` — any logged-in user can render
 * any user's avatar photo (attribution in shared spaces). File rows are ScopedRecords and
 * `GET /file/:id` reads through the OWNER's scope, so other users cannot fetch an avatar through
 * it; this route is the deliberate, narrow door instead.
 *
 * System-read surface is exactly: the user row (for `avatarFileId`), that one file row (for the
 * Content-Type), and its bytes. The file id is never taken from the request — only the id stored
 * on the user row is served, so this can never read arbitrary files. `:userId` is a keyed lookup
 * (no path/filesystem interpretation). Bytes come through the deliberately-unscoped DRIVER read:
 * the route has already made its own access decision above, and the gated service read
 * (`FileStorage.getFileData` — the caller's row-read as the byte-access check) would refuse every
 * viewer but the avatar's owner.
 *
 * Cache contract (mirrored by `avatarRoute` in @proteinjs/user routes.ts): the path is stable per
 * user, so responses carry `max-age=86400, immutable`; clients bust with `?v=<avatarFileId>`,
 * which changes on every photo update. Users with an emoji avatar or no avatar answer 404 — the
 * client renders emoji/initials from the user record; this route serves photos only.
 */
export const avatar: Route = {
  path: '/avatar/:userId',
  method: 'get',
  onRequest: async (request, response): Promise<void> => {
    if (!UserAuth.isLoggedIn()) {
      response.status(401).send('User not logged in');
      return;
    }

    try {
      const userId = request.params.userId;
      const user = await getDbAsSystem().get(tables.User, { id: userId });
      if (!user || !user.avatarFileId) {
        response.status(404).send('No avatar photo');
        return;
      }

      const file = await getScopedDbAsSystem<File>().get(fileTables.File, { id: user.avatarFileId });
      if (!file) {
        response.status(404).send('No avatar photo');
        return;
      }

      const fileDataBase64 = await FileStorage.getDriver().getFileData(file.id);
      response.setHeader('Content-Type', file.type);
      response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      response.send(Buffer.from(fileDataBase64, 'base64'));
    } catch (error: any) {
      logger.error({ message: 'Failed to serve avatar', error });
      response.status(500).send('Internal Server Error');
    }
  },
};
