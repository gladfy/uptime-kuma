// Adds per-status-page option to expand the children of a group monitor
exports.up = function (knex) {
    return knex.schema.alterTable("monitor_group", function (table) {
        table.boolean("show_children").notNullable().defaultTo(false);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor_group", function (table) {
        table.dropColumn("show_children");
    });
};
