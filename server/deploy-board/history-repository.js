const { R } = require("redbean-node");
const { log } = require("../../src/util");

/** Table of the fork migration 2026-11-02-1500-create-deploy-board-deploy. */
const TABLE = "deploy_board_deploy";

/**
 * The deploys that ended, in Kuma's database. Every failure is logged and swallowed: the board keeps
 * working in memory when the database does not answer.
 */
class DeployHistoryRepository {
    /**
     * @param {object} options Options.
     * @param {Function} options.knex Returns the knex instance, or nothing while there is no database
     * (Kuma sets it up after the board is created).
     */
    constructor({ knex = () => R.knex } = {}) {
        this.knex = knex;
        this.queue = Promise.resolve();
    }

    /**
     * @returns {boolean} Whether there is a database to talk to.
     */
    available() {
        try {
            return !!this.knex();
        } catch (e) {
            return false;
        }
    }

    /**
     * @param {number} since Oldest end time to load, in ms.
     * @returns {Promise<object[]>} Records that ended since then, newest first; [] on failure.
     */
    async load(since) {
        if (!this.available()) {
            return [];
        }
        try {
            const rows = await this.knex()(TABLE).where("ended_at", ">=", since).orderBy("ended_at", "desc");
            const records = [];
            for (const row of rows) {
                try {
                    records.push(JSON.parse(row.data));
                } catch (e) {
                    log.warn("deploy-board", `History row ${row.id} is not valid JSON; skipped.`);
                }
            }
            return records;
        } catch (e) {
            log.error("deploy-board", `Could not read the history from the database: ${e.message}`);
            return [];
        }
    }

    /**
     * Insert or replace the record of a deploy. Writes run one at a time, in order, so a deploy that
     * ends twice (reopened by a later rollout of the same commit) keeps the last version.
     * @param {object} record History record.
     * @returns {Promise<void>} Settles when this write is done; never rejects.
     */
    save(record) {
        if (!this.available()) {
            return Promise.resolve();
        }
        const row = {
            deploy_id: record.id,
            project: record.project,
            sha: record.sha || null,
            started_at: record.startedAt,
            ended_at: record.endedAt,
            data: JSON.stringify(record),
        };
        this.queue = this.queue.then(async () => {
            try {
                await this.knex()(TABLE).insert(row).onConflict("deploy_id").merge();
            } catch (e) {
                // Only the id: the record is the deploy itself, and the log is not where it belongs.
                log.error("deploy-board", `Could not save deploy ${record.id}: ${e.message}`);
            }
        });
        return this.queue;
    }

    /**
     * @param {number} before Records that ended before this time (ms) are deleted.
     * @returns {Promise<number>} How many were deleted; 0 on failure.
     */
    async prune(before) {
        if (!this.available()) {
            return 0;
        }
        try {
            return await this.knex()(TABLE).where("ended_at", "<", before).delete();
        } catch (e) {
            log.error("deploy-board", `Could not prune the history: ${e.message}`);
            return 0;
        }
    }
}

module.exports = {
    TABLE,
    DeployHistoryRepository,
};
