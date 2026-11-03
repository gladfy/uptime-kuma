<template>
    <div class="db-grid-area" :class="{ 'is-fill': fill }">
        <div class="db-grid" :style="gridStyle">
            <div
                v-for="(cell, i) in cells"
                :key="cell ? cell.id : 'empty-' + i"
                class="db-row"
                :class="rowClass(cell, i)"
            >
                <template v-if="cell">
                    <span class="db-row-name" :title="cell.name">{{ cell.name }}</span>
                    <!-- Words only for the exception: a monitor that is up says so by its bars. -->
                    <span v-if="cell.tone !== 'up'" class="db-pill" :class="'is-' + cell.tone">
                        <span v-if="cell.tone === 'down'" aria-hidden="true">▲</span>
                        {{ cell.label }}
                    </span>
                    <span v-else class="db-visually-hidden">{{ cell.label }}</span>
                    <span v-if="cell.mark" class="db-pill" :class="cell.mark === 'stuck' ? 'is-stuck' : 'is-deploy'">
                        {{ $t(cell.mark === "stuck" ? "deployBoardMarkStuck" : "deployBoardMarkRolling") }}
                    </span>
                    <span class="db-beats" aria-hidden="true">
                        <i v-for="(beat, b) in cell.beats" :key="b" :class="'b-' + beat"></i>
                    </span>
                </template>
            </div>
        </div>
    </div>
</template>

<script>
/** Columns of the wall layout, and of the stacked one below it. */
const WALL_COLUMNS = 3;
const STACKED_COLUMNS = 2;

/** Below this width two columns no longer fit a name and its bars: one column. */
const NARROW_QUERY = "(max-width: 640px)";

export default {
    props: {
        /** Monitors to draw, in the order of the status page: { id, name, label, tone, beats, mark } */
        monitors: {
            type: Array,
            required: true,
        },
        /** True when the board is a one-screen wall layout; false when it stacks and scrolls. */
        fill: {
            type: Boolean,
            default: true,
        },
    },

    data() {
        return {
            narrow: window.matchMedia(NARROW_QUERY).matches,
        };
    },

    computed: {
        /** @returns {number} Columns of the grid */
        cols() {
            if (this.fill) {
                return WALL_COLUMNS;
            }
            return this.narrow ? 1 : STACKED_COLUMNS;
        },

        /** @returns {number} Rows of every column */
        rows() {
            return Math.max(1, Math.ceil(this.monitors.length / this.cols));
        },

        /**
         * The monitors filled top to bottom, column by column, and the last column completed with
         * empty cells, so the rows line up across columns and the grid has no hole at the end.
         * A monitor keeps its place whatever its state: the team knows where each one is.
         * @returns {Array<object|null>} Cells, column-major; null is an empty cell.
         */
        cells() {
            const cells = [...this.monitors];
            while (cells.length < this.rows * this.cols) {
                cells.push(null);
            }
            return cells;
        },

        /** @returns {object} Grid geometry */
        gridStyle() {
            return { "--db-cols": this.cols, "--db-rows": this.rows };
        },
    },

    mounted() {
        this.narrowQuery = window.matchMedia(NARROW_QUERY);
        this.onNarrow = (e) => {
            this.narrow = e.matches;
        };
        this.narrowQuery.addEventListener("change", this.onNarrow);
    },

    beforeUnmount() {
        this.narrowQuery?.removeEventListener("change", this.onNarrow);
    },

    methods: {
        /**
         * @param {object|null} cell Monitor, or null for an empty cell.
         * @param {number} i Position, column-major.
         * @returns {object} Classes: the state, and which separators the cell draws.
         */
        rowClass(cell, i) {
            return {
                ["is-" + (cell ? cell.tone : "empty")]: true,
                "is-deploying": cell?.mark === "rolling",
                "is-last-row": i % this.rows === this.rows - 1,
                "is-last-col": i >= (this.cols - 1) * this.rows,
            };
        },
    },
};
</script>

<style lang="scss" scoped>
.db-grid-area {
    position: relative;
    min-width: 0;

    // Only the wall layout has a fixed height to share out; stacked, the grid takes what it needs.
    &.is-fill {
        flex: 1 1 0;
        min-height: 0;
    }
}

/* One surface split in columns: a row per monitor, with hairlines and no box around each one. */
.db-grid {
    display: grid;
    grid-auto-flow: column;
    grid-template-columns: repeat(var(--db-cols), minmax(0, 1fr));
    grid-template-rows: repeat(var(--db-rows), minmax(52px, auto));
    overflow: hidden;
    background: var(--db-panel);
    border: 1px solid var(--db-line);
    border-radius: 14px;

    .is-fill & {
        height: 100%;
        grid-template-rows: repeat(var(--db-rows), minmax(0, 1fr));
    }
}

.db-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    padding: 0 16px;
    border-right: 1px solid var(--db-line);
    border-bottom: 1px solid var(--db-line);

    &.is-last-row {
        border-bottom: 0;
    }

    &.is-last-col {
        border-right: 0;
    }

    // A 3 px mark on the side for the two states that matter from across the room.
    &.is-deploying::before,
    &.is-down::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 3px;
        background: var(--db-deploy);
    }

    &.is-down {
        background: var(--db-bad-soft);

        &::before {
            background: var(--db-bad);
        }

        .db-row-name {
            color: var(--db-bad);
        }
    }
}

.db-row-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 17px;
    font-weight: 600;
}

.db-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}

.db-pill {
    flex-shrink: 0;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
    color: var(--db-ink-2);
    background: var(--db-panel-2);

    &.is-deploy {
        color: var(--db-deploy);
        background: var(--db-deploy-soft);
    }

    &.is-down {
        color: var(--db-on-bad);
        background: var(--db-bad-solid);
    }

    &.is-pending {
        color: var(--db-warn);
        background: var(--db-warn-soft);
    }

    &.is-maintenance {
        color: var(--db-maint);
        background: var(--db-maint-soft);
    }

    &.is-stuck {
        color: var(--db-bad);
        background: var(--db-bad-soft);
    }
}

/* Right-aligned and clipped: when the row is short of room, the oldest bars give way. */
.db-beats {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
    flex: 0 1 calc(24 * 6px);
    min-width: 48px;
    height: 16px;
    overflow: hidden;

    i {
        flex: 0 0 4px;
        border-radius: 2px;
        background: var(--db-panel-2);
    }

    .b-up {
        background: var(--db-ok);
    }

    .b-pending {
        background: var(--db-warn);
    }

    .b-down {
        background: var(--db-bad);
    }

    .b-maintenance {
        background: var(--db-maint);
    }
}
</style>
