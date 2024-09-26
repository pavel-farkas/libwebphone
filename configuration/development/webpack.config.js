const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: "development",
  entry: './src/index.js',
  // plugins: [
  //   new HtmlWebpackPlugin({
  //     title: 'Development',
  //   }),
  // ],
  performance: {
    hints: "warning",
  },
  output: {
    filename: "libwebphone.js",
    path: path.resolve(__dirname, '../../dist'),
    // clean: true,
    library: "libwebphone",
    libraryTarget: "var",
  },
  devtool: "inline-source-map",
  devServer: {
    liveReload: true,
    static: './dist',
    client: {
      overlay: false,
    },
  },
  // optimization: {
  //   runtimeChunk: 'single',
  // },
};
