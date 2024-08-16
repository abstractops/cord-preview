### Downloading the existing Cord data

1. run `npm install -g @cord-sdk/cli` to install [cord cli](https://docs.cord.com/reference/cord-cli)
2. run `cord init` using the customer_id and its respective secret from [cord console settings page](https://console.cord.com/settings/customer)
3. run `cord curl project -- -o db-dump.sql https://api.cord.com/v1/customer/dbdump` to download db dump SQL script (this will take a while depending on the amount of existing data)
4. clone repo https://github.com/getcord/cord-preview and follow instructions to start it locally
5. run db dump script against the `radical_db` database (you can find the db password in the env file)
