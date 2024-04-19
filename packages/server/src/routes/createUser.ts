import sha256 from 'crypto-js/sha256';
import { Route } from '@proteinjs/server-api';
import { getSystemDb } from '@proteinjs/db';
import { User, tables, routes } from '@proteinjs/user';
import { Logger } from '@proteinjs/util';

export const createUser: Route = {
    path: routes.createUser.path,
    method: routes.createUser.method,
    onRequest: async (request, response): Promise<void> => {
        const logger = new Logger('createUser');
        const user = request.body as User;
        const db = getSystemDb();
        const userRecord = await db.get(tables.User, { email: user.email });
        if (userRecord) {
            const error = `User with this email already exists`;
            console.error(`${error}: ${user.email}`);
            response.send({ error });
            return;
        }

        await db.insert(tables.User, {
            name: user.name,
            email: user.email,
            password: sha256(user.password).toString(),
            emailVerified: false,
            roles: '',
        });
        logger.info(`Created user: ${user.email}`);
        response.send({});
    }
}