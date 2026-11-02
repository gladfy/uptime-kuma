// Deploy board (fork only): the deploys that ended, so the "Today" list survives a restart.
exports.up = function (knex) {
    return knex.schema.createTable("deploy_board_deploy", function (table) {
        table.increments("id");
        // 128: a unique index on utf8mb4 stays under the 767-byte limit of older MariaDB row formats.
        table.string("deploy_id", 128).notNullable().unique();
        table.string("project", 255).notNullable();
        table.string("sha", 40).nullable();
        // Milliseconds since the epoch, as the board keeps them.
        table.bigInteger("started_at").notNullable();
        table.bigInteger("ended_at").notNullable().index();
        table.text("data").notNullable();
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("deploy_board_deploy");
};
