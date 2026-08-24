const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");

class Group extends BeanModel {
    /**
     * Return an object that ready to parse to JSON for public Only show
     * necessary data to public
     * @param {boolean} showTags Should the JSON include monitor tags
     * @param {boolean} certExpiry Should JSON include info about
     * certificate expiry?
     * @returns {Promise<object>} Object ready to parse
     */
    async toPublicJSON(showTags = false, certExpiry = false) {
        let monitorBeanList = await this.getMonitorList();
        let monitorList = [];

        for (let bean of monitorBeanList) {
            let monitorObj = await bean.toPublicJSON(showTags, certExpiry);
            monitorObj.showChildren = !!bean.showChildren;

            // Expand the direct children of a group monitor when enabled for this status page row.
            // Children expose id/name/type only: they have no monitor_group row, so no URL can leak.
            if (monitorObj.showChildren && bean.type === "group") {
                monitorObj.childrenList = await R.getAll(
                    `
                    SELECT id, name, type FROM monitor
                    WHERE parent = ?
                    AND active = 1
                    ORDER BY name
                `,
                    [bean.id]
                );
            }

            monitorList.push(monitorObj);
        }

        return {
            id: this.id,
            name: this.name,
            weight: this.weight,
            monitorList,
        };
    }

    /**
     * Get all monitors
     * @returns {Promise<Bean[]>} List of monitors
     */
    async getMonitorList() {
        return R.convertToBeans(
            "monitor",
            await R.getAll(
                `
            SELECT monitor.*, monitor_group.send_url, monitor_group.custom_url, monitor_group.show_children FROM monitor, monitor_group
            WHERE monitor.id = monitor_group.monitor_id
            AND group_id = ?
            ORDER BY monitor_group.weight
        `,
                [this.id]
            )
        );
    }
}

module.exports = Group;
