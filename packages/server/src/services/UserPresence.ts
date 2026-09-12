import { Service } from '@proteinjs/service';
import { UserPresenceService, UserRepo, type User } from '@proteinjs/user';
import { UserActivityStamp } from '../authorization/UserActivityStamp';

/**
 * The server end of the human-input presence door (UserActivityTable's contract): the page
 * reports "a person interacted just now" and this writes the `user_activity` stamp for the
 * CALLING user — the one write path onto presence. Any signed-in user may report their own
 * presence and nobody else's (the user is the session's, never an argument); the guest identity
 * and machine accounts are refused inside the stamp. `doNotAwait`: the page never waits on its
 * own stamp, and a lost stamp is minutes of staleness at day grain, never a failed call.
 */
export class UserPresence implements UserPresenceService {
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      allUsers: true,
    },
    doNotAwait: true,
  };

  private stamp = new UserActivityStamp();

  async recordPresence(): Promise<void> {
    await this.stamp.recordHumanInput(new UserRepo().getUser() as Pick<User, 'id' | 'machine'>);
  }
}
