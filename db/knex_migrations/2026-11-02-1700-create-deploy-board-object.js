// Deploy board (fork only): the last version seen of each Deployment and CronJob, so a rollout made
// while the board was down (its own deploy, with Recreate) shows up after the boot.
exports.up = function (knex) {
    return knex.schema.createTable("deploy_board_object", function (table) {
        table.increments("id");
        // "<kind>/<namespace>/<name>": 160 keeps a unique utf8mb4 index under 767 bytes.
        table.string("object_key", 160).notNullable().unique();
        table.text("signature").notNullable();
        table.bigInteger("seen_at").notNullable();
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("deploy_board_object");
};
