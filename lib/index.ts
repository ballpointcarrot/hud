import * as AWS from "aws-sdk";
import formatDistance from "date-fns/formatDistance";
import _ from "lodash";
import { RateLimiter } from "limiter";
import * as blessed from "blessed";
import * as contrib from "blessed-contrib";
import chalk from "chalk";

const pipeline = new AWS.CodePipeline();

function getPipelineDetails(name: string) {
  return pipeline.getPipelineState({ name }).promise();
}

function colorizedStatus(statuses: Set<string>): string {
  if (statuses.has("Failed")) {
    return chalk.bgRed("Failed".padEnd(10, " "));
  }

  statuses.delete("Succeeded");
  if (statuses.size === 0) {
    return chalk.bgGreen("Succeeded".padEnd(10, " "));
  }

  return chalk.bgBlue(statuses.values().next().value.padEnd(10, " "));
}

const limiter = new RateLimiter(5, "second");

function removeToken() {
  return new Promise((resolve, reject) => {
    limiter.removeTokens(1, (err, remainingRequests) => {
      if (err) return reject(err);
      resolve(remainingRequests);
    });
  });
}

function humanizeTime(time: Date): string {
  return formatDistance(time, new Date(), { addSuffix: true });
}

function fetchPipelines() {
  pipeline
    .listPipelines()
    .promise()
    .then(output => {
      const watched = output.pipelines?.filter(pp => {
        if (pp.name?.match(/^integration/i)) {
          return true;
        }
        return false;
      });
      if (watched) {
        return Promise.all(
          watched.map(pp => {
            return removeToken().then(() => {
              return getPipelineDetails(pp.name!);
            });
          })
        );
      }
      return [];
    })
    .then(pipelineStats => {
      table.set("stats", pipelineStats);
      const mappedStats = pipelineStats.map(
        (pipeline: AWS.CodePipeline.GetPipelineStateOutput) => {
          return {
            pipelineName: pipeline.pipelineName,
            stages: pipeline.stageStates?.map(stage => {
              return {
                stageName: stage.stageName,
                status: stage.latestExecution?.status,
                actions: stage.actionStates?.map(action => {
                  return {
                    actionName: action.actionName,
                    status: action.latestExecution?.status,
                    lastRun:
                      action.latestExecution?.lastStatusChange &&
                      humanizeTime(action.latestExecution?.lastStatusChange),
                    source: action.revisionUrl
                  };
                })
              };
            })
          };
        }
      );
      return mappedStats;
    })
    .then(mappedStats => {
      const stats = mappedStats.map(pipeline => {
        if (!pipeline.stages) {
          return [];
        }
        return [
          pipeline.pipelineName?.slice(0, 30) ?? "",
          colorizedStatus(new Set(pipeline.stages.map(s => s.status ?? "")))
        ];
      });
      screen.debug(JSON.stringify(stats, null, 2));
      table.setData({
        headers: ["Pipeline", "Status"],
        data: stats
      });
    });
}

fetchPipelines();
setInterval(fetchPipelines, 60 * 1000);

const screen = blessed.screen({ debug: true });
screen.program.disableMouse();

const grid = new contrib.grid({ rows: 4, cols: 4, screen: screen });

const table = grid.set(0, 0, 1, 4, contrib.table, {
  keys: true,
  tags: true,
  fg: "white",
  selectedFg: "white",
  selectedBg: "blue",
  interactive: "true",
  label: "Pipelines",
  border: {
    type: "line",
    fg: "white"
  },
  columnWidth: [30, 10]
});

const detailTable = grid.set(1, 0, 3, 4, blessed.list, {
  keys: true,
  tags: true,
  fg: "white",
  interactive: "false",
  label: "Pipeline Details",
  border: {
    type: "line",
    fg: "white"
  }
});

table.focus();
(table as any).rows.on("select item", (node: blessed.Widgets.ListElement) => {
  detailTable.clearItems();
  const stats = table.get<AWS.CodePipeline.GetPipelineStateOutput[]>(
    "stats",
    []
  );
  const pipeline = stats.find(p =>
    p.pipelineName!.startsWith(node.content.split(" ")[0])
  );
  if (pipeline) {
    _.each(pipeline!.stageStates, (stage): void => {
      if (stage) {
        _.each(stage.actionStates, (action): void => {
          detailTable.add(
            `Stage: ${stage.stageName}\tAction: ${action.actionName}\tStatus: ${
              action.latestExecution!.status
            }`
          );
          detailTable.add(
            `\tLast Ran: ${humanizeTime(
              action.latestExecution!.lastStatusChange!
            )}`
          );
          detailTable.add(
            `\tLink: ${action.revisionUrl ?? action.entityUrl ?? ""}`
          );
          detailTable.add("");
        });
      }
    });
  }
});

screen.key(["escape", "q", "C-c"], () => {
  return process.exit(0);
});

screen.render();
