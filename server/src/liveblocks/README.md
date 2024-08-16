### Downloading the existing Cord data

1. run `npm install -g @cord-sdk/cli` to install [cord cli](https://docs.cord.com/reference/cord-cli)
2. run `cord init` using the customer_id and its respective secret from [cord console settings page](https://console.cord.com/settings/customer)
3. run `cord curl project -- -o db-dump.sql https://api.cord.com/v1/customer/dbdump` to download db dump SQL script (this will take a while depending on the amount of existing data)
4. clone repo https://github.com/getcord/cord-preview and follow instructions to start it locally
5. run db dump script against the `radical_db` database (you can find the db password in the env file)

### Migrating the Cord data to Liveblocks

Before going through the steps, you need to pick from and where you want to do the migration: test/staging OR production.

1. have the `radical_db` ready with the correct data (see the `Downloading the existing Cord data` section above)
2. add `LIVEBLOCKS_KEY` and `LIVEBLOCKS_KEY_SECRET` values to the `.env` file
3. run `npm local-dev` to start the Cord project locally
4. make a `POST` request to the `/migrate-to-liveblocks` API endpoint to start migrating the data

NOTES:

- if you do not see the migration completed log, some data might did not get pushed to Liveblocks and the migration should be started from scratch by first deleting all the Liveblocks room using the dashboard (technically this can also be done through the node sdk before the migration starts)
