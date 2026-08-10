import moment from 'moment';

export const guestUser = {
  name: 'Guest',
  email: 'guest',
  password: 'guest',
  emailVerified: false,
  roles: [] as string[],
  created: moment(),
  updated: moment(),
  id: 'guest',
};
